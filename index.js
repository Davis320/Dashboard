const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');
// ── SP-API module (inlined) ──
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




const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: '*' }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

// ── SP-API routes ─────────────────────────────────────────────────────────────

// GET /sp/price?asin=B001234&pwd=...
app.get('/sp/price', async (req, res) => {
  if (!auth(req, res)) return;
  const { asin } = req.query;
  if (!asin) return res.status(400).json({ success: false, error: 'asin required' });
  try {
    const data = await getPrice(asin);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /sp/fees?asin=B001234&price=14.99&pwd=...
app.get('/sp/fees', async (req, res) => {
  if (!auth(req, res)) return;
  const { asin, price } = req.query;
  if (!asin || !price) return res.status(400).json({ success: false, error: 'asin and price required' });
  try {
    const data = await getFees(asin, +price);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /sp/inventory?pwd=...  — all FBA inventory
app.get('/sp/inventory', async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const items = await getAllInventory();
    res.json({ success: true, count: items.length, items });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /sp/orders?days=30&pwd=...
app.get('/sp/orders', async (req, res) => {
  if (!auth(req, res)) return;
  const days = Math.min(+(req.query.days || 30), 180);
  try {
    const data = await getOrders(days);
    res.json({ success: true, ...data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /sp/sku-summary?sku=XX&asin=B0...&pwd=...  — combined for tooltip
app.get('/sp/sku-summary', async (req, res) => {
  if (!auth(req, res)) return;
  const { sku, asin } = req.query;
  if (!sku && !asin) return res.status(400).json({ success: false, error: 'sku or asin required' });
  try {
    const data = await getSkuSummary(sku, asin);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});


app.get("/api/debug-headers", (req, res) => { res.json({ headers: req.headers }); });
app.get("/api/debug-db", async (req, res) => {
  try {
    const r = await pool.query('SELECT NOW() as now');
    res.json({ success: true, now: r.rows[0].now });
  } catch(err) {
    res.json({ success: false, error: err.message, code: err.code, detail: err.detail, hint: err.hint });
  }
});

// List all datasets + last updated times
app.get('/api/data', async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const result = await pool.query('SELECT dataset, updated_at FROM dashboard_data ORDER BY dataset');
    const status = {};
    VALID_DATASETS.forEach(d => { status[d] = null; });
    result.rows.forEach(r => { status[r.dataset] = r.updated_at; });
    res.json({ success: true, datasets: status });
  } catch (err) {
    res.status(500).json({ success: false, error: String(err), code: err.code, detail: err.detail });
  }
});

// GET a dataset
app.get('/api/data/:dataset', async (req, res) => {
  if (!auth(req, res)) return;
  const { dataset } = req.params;
  if (!VALID_DATASETS.includes(dataset)) return res.status(400).json({ success:false, error:'Unknown dataset' });
  try {
    const result = await pool.query('SELECT payload, updated_at FROM dashboard_data WHERE dataset=$1', [dataset]);
    if (!result.rows.length) return res.json({ success:true, data:null, updatedAt:null });
    res.json({ success:true, data:result.rows[0].payload, updatedAt:result.rows[0].updated_at });
  } catch (err) {
    res.status(500).json({ success:false, error:err.message });
  }
});

// POST (save/overwrite) a dataset
app.post('/api/data/:dataset', async (req, res) => {
  if (!auth(req, res)) return;
  const { dataset } = req.params;
  if (!VALID_DATASETS.includes(dataset)) return res.status(400).json({ success:false, error:'Unknown dataset' });
  try {
    await pool.query(`
      INSERT INTO dashboard_data (dataset, payload, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (dataset) DO UPDATE SET payload=$2, updated_at=NOW()
    `, [dataset, JSON.stringify(req.body)]);
    res.json({ success:true, dataset, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success:false, error:err.message });
  }
});