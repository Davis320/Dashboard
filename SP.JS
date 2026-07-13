// ============================================================
// Amazon SP-API Module
// Clean, cached, rate-limit-aware wrapper
// ============================================================

const axios = require('axios');

const CLIENT_ID     = process.env.SP_CLIENT_ID;
const CLIENT_SECRET = process.env.SP_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.SP_REFRESH_TOKEN;
const MARKETPLACE   = process.env.SP_MARKETPLACE_ID || 'ATVPDKIKX0DER';
const SP_BASE       = 'https://sellingpartnerapi-na.amazon.com';

// ── Token management ──────────────────────────────────────────────────────────
let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const res = await axios.post('https://api.amazon.com/auth/o2/token', {
    grant_type:    'refresh_token',
    refresh_token: REFRESH_TOKEN,
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
  });
  _token = res.data.access_token;
  _tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return _token;
}

// ── Generic SP-API request with rate-limit retry ──────────────────────────────
async function spRequest(method, path, params = {}, body = null, retries = 3) {
  const token = await getToken();
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const config = {
        method,
        url: SP_BASE + path,
        headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
        params,
      };
      if (body) config.data = body;
      const res = await axios(config);
      return res.data;
    } catch (err) {
      const status = err.response?.status;
      if (status === 429 && attempt < retries - 1) {
        const wait = parseInt(err.response?.headers?.['retry-after'] || '2') * 1000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw err;
    }
  }
}

const spGet  = (path, params)       => spRequest('GET',  path, params);
const spPost = (path, body, params) => spRequest('POST', path, params, body);

// ── Simple TTL cache ──────────────────────────────────────────────────────────
const _cache = {};
function cache(key, ttlMs, fn) {
  const hit = _cache[key];
  if (hit && Date.now() < hit.exp) return Promise.resolve(hit.val);
  return fn().then(val => {
    _cache[key] = { val, exp: Date.now() + ttlMs };
    return val;
  });
}

const MIN = 60 * 1000;

// ── Pricing: current Buy Box price ───────────────────────────────────────────
async function getPrice(asin) {
  return cache(`price:${asin}`, 15 * MIN, async () => {
    const data = await spGet('/products/pricing/v0/price', {
      MarketplaceId: MARKETPLACE,
      Asins: asin,
      ItemType: 'Asin',
    });
    const product = data?.payload?.[0]?.Product;
    const offers  = product?.Offers || [];
    const buyBox  = offers.find(o => o.IsBuyBoxWinner)?.BuyingPrice
                 || offers[0]?.BuyingPrice;

    return {
      asin,
      currentPrice:    buyBox?.LandedPrice?.Amount   ?? buyBox?.ListingPrice?.Amount ?? null,
      listingPrice:    buyBox?.ListingPrice?.Amount   ?? null,
      shipping:        buyBox?.Shipping?.Amount       ?? null,
      offerCount:      offers.length,
      currency:        buyBox?.ListingPrice?.CurrencyCode ?? 'USD',
    };
  });
}

// ── Fees: FBA fee + referral fee estimate ────────────────────────────────────
async function getFees(asin, price) {
  const priceKey = Math.round(price * 100); // avoid float key issues
  return cache(`fees:${asin}:${priceKey}`, 60 * MIN, async () => {
    const data = await spPost(
      `/products/fees/v0/items/${asin}/feesEstimate`,
      {
        FeesEstimateRequest: {
          MarketplaceId: MARKETPLACE,
          IsAmazonFulfilled: true,
          PriceToEstimateFees: {
            ListingPrice: { CurrencyCode: 'USD', Amount: price },
            Shipping:     { CurrencyCode: 'USD', Amount: 0 },
          },
          Identifier: asin,
          OptionalFulfillmentProgram: 'FBA_CORE',
        },
      }
    );

    const result     = data?.payload?.FeesEstimateResult;
    const feeList    = result?.FeesEstimate?.FeeDetailList ?? [];
    const totalFees  = result?.FeesEstimate?.TotalFeesEstimate?.Amount ?? null;

    let fbaFee = 0, referralFee = 0;
    feeList.forEach(f => {
      if (['FBAPerUnitFulfillmentFee','FBAPerOrderFulfillmentFee','FBAWeightBasedFee'].includes(f.FeeType)) {
        fbaFee += +(f.FeeAmount?.Amount || 0);
      }
      if (f.FeeType === 'ReferralFee') {
        referralFee = +(f.FeeAmount?.Amount || 0);
      }
    });

    return { asin, price, fbaFee, referralFee, totalFees };
  });
}

// ── Inventory: FBA inventory levels ──────────────────────────────────────────
async function getInventory(nextToken = null) {
  return cache(`inventory:all:${nextToken||'first'}`, 30 * MIN, async () => {
    const params = {
      marketplaceIds: MARKETPLACE,
      details: true,
      granularityType: 'Marketplace',
      granularityId: MARKETPLACE,
    };
    if (nextToken) params.nextToken = nextToken;
    const data = await spGet('/fba/inventory/v1/summaries', params);
    const items = data?.payload?.inventorySummaries ?? [];
    return {
      items: items.map(i => ({
        sku:            i.sellerSku,
        asin:           i.asin,
        fnSku:          i.fnSku,
        condition:      i.condition,
        totalQty:       i.inventoryDetails?.fulfillableQuantity ?? i.totalQuantity ?? 0,
        inboundQty:     (i.inventoryDetails?.inboundShippingQuantity ?? 0) +
                        (i.inventoryDetails?.inboundReceivingQuantity ?? 0),
        reservedQty:    i.inventoryDetails?.reservedQuantity?.totalReservedQuantity ?? 0,
        unfulfillable:  i.inventoryDetails?.unfulfillableQuantity?.totalUnfulfillableQuantity ?? 0,
      })),
      nextToken: data?.pagination?.nextToken ?? null,
    };
  });
}

async function getAllInventory() {
  const results = [];
  let nextToken = null;
  let page = 0;
  do {
    const { items, nextToken: nt } = await getInventory(nextToken);
    results.push(...items);
    nextToken = nt;
    if (++page > 20) break; // safety cap
  } while (nextToken);
  return results;
}

// ── Orders: recent orders + line items ───────────────────────────────────────
async function getOrders(days = 30) {
  return cache(`orders:${days}d`, 60 * MIN, async () => {
    const createdAfter = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
    const data = await spGet('/orders/v0/orders', {
      MarketplaceIds: MARKETPLACE,
      CreatedAfter: createdAfter,
      OrderStatuses: 'Shipped,Unshipped,PartiallyShipped,Pending',
      MaxResultsPerPage: 100,
    });

    const orders = data?.payload?.Orders ?? [];
    const summary = {
      totalOrders: orders.length,
      totalRevenue: 0,
      byDay: {},
      topAsins: {},
    };

    orders.forEach(o => {
      const day = o.PurchaseDate?.slice(0, 10);
      if (day) summary.byDay[day] = (summary.byDay[day] || 0) + 1;
      const amt = +(o.OrderTotal?.Amount || 0);
      summary.totalRevenue += amt;
    });

    return { orders: orders.slice(0, 200), summary };
  });
}

// ── SKU Summary: all data combined for tooltip ────────────────────────────────
async function getSkuSummary(sku, asin) {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    return { error: 'SP_API credentials not configured' };
  }
  try {
    const result = { sku, asin };

    // Price
    if (asin) {
      try {
        const p = await getPrice(asin);
        Object.assign(result, p);
      } catch (e) { result.priceError = e.message; }
    }

    // Fees
    if (asin && result.currentPrice) {
      try {
        const f = await getFees(asin, result.currentPrice);
        result.fbaFee     = f.fbaFee;
        result.referralFee = f.referralFee;
        result.totalFees  = f.totalFees;
      } catch (e) { result.feesError = e.message; }
    }

    // Inventory for this SKU
    try {
      const inv = await getAllInventory();
      const item = inv.find(i => i.sku === sku || i.asin === asin);
      if (item) {
        result.fbaQty       = item.totalQty;
        result.inboundQty   = item.inboundQty;
        result.reservedQty  = item.reservedQty;
      }
    } catch (e) { result.inventoryError = e.message; }

    return result;
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { getPrice, getFees, getInventory, getAllInventory, getOrders, getSkuSummary };