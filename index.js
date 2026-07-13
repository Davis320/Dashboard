const express = require('express');
const cors    = require('cors');
const path    = require('path');
const axios   = require('axios');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: '*' }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

// ── Database ──────────────────────────────────────────────────────────────────
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const pool = new Pool({
  host: 'thomas.proxy.rlwy.net',
  port: 59087,
  database: 'railway',
  user: 'postgres',
  password: 'KRiYmNDcTrqeRpWNYSRgCmwPNkqtFxku',
});

// ── Auth ──────────────────────────────────────────────────────────────────────
const VALID_DATASETS = ['mapping','od','invreport','compreport','plreport','inbound','comments','buildship'];
const FALLBACK_PASSWORD = 'Goodmorning2';

function auth(req, res) {
  const pwd = process.env.DASHBOARD_PASSWORD || FALLBACK_PASSWORD;
  const sent = req.headers['x-dashboard-password'] || req.query.pwd || '';
  if (sent !== pwd) {
    res.status(401).json({ success:false, error:'Invalid password' });
    return false;
  }
  return true;
}

// ── SP-API ────────────────────────────────────────────────────────────────────
let SP_CLIENT_ID     = process.env.SP_CLIENT_ID;
let SP_CLIENT_SECRET = process.env.SP_CLIENT_SECRET;
let SP_REFRESH_TOKEN = process.env.SP_REFRESH_TOKEN;
const SP_MARKETPLACE = process.env.SP_MARKETPLACE_ID || 'ATVPDKIKX0DER';
const SP_BASE        = 'https://sellingpartnerapi-na.amazon.com';

// Load SP creds from DB if not in env
async function ensureSpCreds() {
  if (SP_CLIENT_ID && SP_CLIENT_SECRET && SP_REFRESH_TOKEN) return true;
  try {
    const r = await pool.query("SELECT payload FROM dashboard_data WHERE dataset='sp_creds'");
    if (r.rows.length) {
      const c = r.rows[0].payload;
      SP_CLIENT_ID     = SP_CLIENT_ID     || c.clientId;
      SP_CLIENT_SECRET = SP_CLIENT_SECRET || c.clientSecret;
      SP_REFRESH_TOKEN = SP_REFRESH_TOKEN || c.refreshToken;
      return !!(SP_CLIENT_ID && SP_CLIENT_SECRET && SP_REFRESH_TOKEN);
    }
  } catch(e) { console.error('ensureSpCreds error:', e.message); }
  return false;
}

let _spToken = null, _spTokenExpiry = 0;

async function getSpToken() {
  if (_spToken && Date.now() < _spTokenExpiry) return _spToken;
  const res = await axios.post('https://api.amazon.com/auth/o2/token', {
    grant_type: 'refresh_token',
    refresh_token: SP_REFRESH_TOKEN,
    client_id: SP_CLIENT_ID,
    client_secret: SP_CLIENT_SECRET,
  });
  _spToken = res.data.access_token;
  _spTokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
  return _spToken;
}

async function spGet(path, params = {}) {
  const token = await getSpToken();
  try {
    const res = await axios.get(SP_BASE + path, {
      headers: { 'x-amz-access-token': token },
      params,
    });
    return res.data;
  } catch(err) {
    const detail = err.response?.data;
    throw new Error((err.response?.status||'?')+': '+(detail?.errors?.[0]?.message||JSON.stringify(detail)||err.message));
  }
}

async function spPost(path, body) {
  const token = await getSpToken();
  try {
    const res = await axios.post(SP_BASE + path, body, {
      headers: { 'x-amz-access-token': token, 'Content-Type': 'application/json' },
    });
    return res.data;
  } catch(err) {
    const detail = err.response?.data;
    throw new Error((err.response?.status||'?')+': '+(detail?.errors?.[0]?.message||JSON.stringify(detail)||err.message));
  }
}

// Simple TTL cache
const _cache = {};
function cached(key, ttlMs, fn) {
  const hit = _cache[key];
  if (hit && Date.now() < hit.exp) return Promise.resolve(hit.val);
  return fn().then(val => { _cache[key] = { val, exp: Date.now() + ttlMs }; return val; });
}
const MIN = 60000;

async function getPrice(asin) {
  return cached('price:'+asin, 15*MIN, async () => {
    // Try competitive pricing first
    try {
      const data = await spGet('/products/pricing/v0/competitivePrice', {
        MarketplaceId: SP_MARKETPLACE,
        Asins: asin,
        ItemType: 'Asin',
      });
      const product = data?.payload?.[0]?.Product;
      const cp = product?.CompetitivePricing?.CompetitivePrices?.find(p => p.condition === 'New' && p.belongsToRequester === false)
               || product?.CompetitivePricing?.CompetitivePrices?.[0];
      const price = cp?.Price?.LandedPrice?.Amount || cp?.Price?.ListingPrice?.Amount || null;
      return { asin, currentPrice: price, offerCount: product?.CompetitivePricing?.NumberOfOfferListings?.[0]?.Count || 0 };
    } catch(e1) {
      // Fallback: item offers
      try {
        const data = await spGet('/products/pricing/v0/items/'+encodeURIComponent(asin)+'/offers', {
          MarketplaceId: SP_MARKETPLACE,
          ItemCondition: 'New',
        });
        const offers = data?.payload?.Offers || [];
        const bb = offers.find(o => o.IsBuyBoxWinner)?.ListingPrice || offers[0]?.ListingPrice;
        return { asin, currentPrice: bb?.Amount || null, offerCount: offers.length };
      } catch(e2) {
        throw new Error('price: '+e1.message+' | '+e2.message);
      }
    }
  });
}

async function getFees(asin, price) {
  return cached('fees:'+asin+':'+Math.round(price*100), 60*MIN, async () => {
    const data = await spPost('/products/fees/v0/items/'+encodeURIComponent(asin)+'/feesEstimate', {
      FeesEstimateRequest: { MarketplaceId: SP_MARKETPLACE, IsAmazonFulfilled: true, Identifier: asin,
        PriceToEstimateFees: { ListingPrice: { CurrencyCode:'USD', Amount: price }, Shipping: { CurrencyCode:'USD', Amount:0 } } }
    });
    const fees = data?.payload?.FeesEstimateResult?.FeesEstimate?.FeeDetailList || [];
    let fbaFee = 0, referralFee = 0;
    fees.forEach(f => {
      if (['FBAPerUnitFulfillmentFee','FBAPerOrderFulfillmentFee','FBAWeightBasedFee'].includes(f.FeeType)) fbaFee += +(f.FeeAmount?.Amount||0);
      if (f.FeeType === 'ReferralFee') referralFee = +(f.FeeAmount?.Amount||0);
    });
    return { asin, price, fbaFee, referralFee };
  });
}

async function getAllInventory() {
  return cached('inventory:all', 30*MIN, async () => {
    // marketplaceIds must be passed as repeated params for some SP-API versions
    const token = await getSpToken();
    const res = await axios.get(SP_BASE + '/fba/inventory/v1/summaries', {
      headers: { 'x-amz-access-token': token },
      params: new URLSearchParams([
        ['granularityType', 'Marketplace'],
        ['granularityId', SP_MARKETPLACE],
        ['marketplaceIds', SP_MARKETPLACE],
        ['details', 'true'],
      ]),
    });
    return (res.data?.payload?.inventorySummaries || []).map(i => ({
      sku: i.sellerSku, asin: i.asin,
      totalQty: i.inventoryDetails?.fulfillableQuantity ?? i.totalQuantity ?? 0,
      inboundQty: (i.inventoryDetails?.inboundShippingQuantity||0)+(i.inventoryDetails?.inboundReceivingQuantity||0),
      reservedQty: i.inventoryDetails?.reservedQuantity?.totalReservedQuantity || 0,
    }));
  });
}

async function getOrders(days) {
  return cached('orders:'+days, 60*MIN, async () => {
    const after = new Date(Date.now() - days*86400000).toISOString();
    const data = await spGet('/orders/v0/orders', { MarketplaceIds: SP_MARKETPLACE, CreatedAfter: after, OrderStatuses: 'Shipped,Unshipped,PartiallyShipped,Pending', MaxResultsPerPage: 100 });
    const orders = data?.payload?.Orders || [];
    const byDay = {};
    let totalRevenue = 0;
    orders.forEach(o => {
      const day = o.PurchaseDate?.slice(0,10);
      if (day) byDay[day] = (byDay[day]||0)+1;
      totalRevenue += +(o.OrderTotal?.Amount||0);
    });
    return { orders: orders.slice(0,200), summary: { totalOrders: orders.length, totalRevenue, byDay } };
  });
}

async function getSkuSummary(sku, asin) {
  const ready = await ensureSpCreds();
  if (!ready) return { error: 'SP-API credentials not configured' };
  try {
    const result = { sku, asin };
    if (asin) {
      try { Object.assign(result, await getPrice(asin)); } catch(e) { result.priceError = e.message; }
      if (result.currentPrice) {
        try { const f = await getFees(asin, result.currentPrice); result.fbaFee = f.fbaFee; result.referralFee = f.referralFee; } catch(e) { result.feesError = e.message; }
      }
    }
    try {
      const inv = await getAllInventory();
      const item = inv.find(i => i.sku===sku||i.asin===asin);
      if (item) { result.fbaQty = item.totalQty; result.inboundQty = item.inboundQty; }
    } catch(e) { result.inventoryError = e.message; }
    return result;
  } catch(err) { return { error: err.message }; }
}

// Save SP-API credentials to DB (so they survive container restarts without env vars)
app.post('/api/sp-creds', async (req, res) => {
  if (!auth(req, res)) return;
  const { clientId, clientSecret, refreshToken } = req.body;
  if (!clientId || !clientSecret || !refreshToken) return res.status(400).json({ success:false, error:'clientId, clientSecret, refreshToken required' });
  try {
    await pool.query(`INSERT INTO dashboard_data (dataset, payload, updated_at) VALUES ('sp_creds', $1, NOW())
      ON CONFLICT (dataset) DO UPDATE SET payload=$1, updated_at=NOW()`,
      [JSON.stringify({ clientId, clientSecret, refreshToken })]);
    SP_CLIENT_ID = clientId; SP_CLIENT_SECRET = clientSecret; SP_REFRESH_TOKEN = refreshToken;
    _spToken = null; // reset cached token
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success:false, error: err.message }); }
});

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/api/health', (req, res) => res.json({ status:'ok', service:'Store Health Tracker API', pwd_configured:true }));

app.get('/api/debug-env', (req, res) => {
  res.json({
    SP_CLIENT_ID_SET: !!process.env.SP_CLIENT_ID,
    SP_CLIENT_ID_LEN: (process.env.SP_CLIENT_ID||'').length,
    SP_SECRET_SET: !!process.env.SP_CLIENT_SECRET,
    SP_TOKEN_SET: !!process.env.SP_REFRESH_TOKEN,
    DASHBOARD_PWD_SET: !!process.env.DASHBOARD_PASSWORD,
    all_sp_keys: Object.keys(process.env).filter(k=>k.startsWith('SP')),
  });
});

// SP-API routes
app.get('/sp/price',       async (req,res) => { if(!auth(req,res))return; try{ res.json({success:true,data:await getPrice(req.query.asin)}); }catch(e){res.status(500).json({success:false,error:e.message});} });
app.get('/sp/fees',        async (req,res) => { if(!auth(req,res))return; try{ res.json({success:true,data:await getFees(req.query.asin,+req.query.price)}); }catch(e){res.status(500).json({success:false,error:e.message});} });
app.get('/sp/inventory',   async (req,res) => { if(!auth(req,res))return; try{ const i=await getAllInventory(); res.json({success:true,count:i.length,items:i}); }catch(e){res.status(500).json({success:false,error:e.message});} });
app.get('/sp/orders',      async (req,res) => { if(!auth(req,res))return; try{ res.json({success:true,...await getOrders(+(req.query.days||30))}); }catch(e){res.status(500).json({success:false,error:e.message});} });
app.get('/sp/sku-summary', async (req,res) => { if(!auth(req,res))return; try{ res.json({success:true,data:await getSkuSummary(req.query.sku,req.query.asin)}); }catch(e){res.status(500).json({success:false,error:e.message});} });

// Debug
app.get('/api/debug-db', async (req,res) => { try{ const r=await pool.query('SELECT NOW()'); res.json({success:true,now:r.rows[0].now}); }catch(e){res.json({success:false,error:e.message});} });

// Dashboard data routes
app.get('/api/data', async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const result = await pool.query('SELECT dataset, updated_at FROM dashboard_data ORDER BY dataset');
    const status = {};
    VALID_DATASETS.forEach(d => { status[d] = null; });
    result.rows.forEach(r => { status[r.dataset] = r.updated_at; });
    res.json({ success: true, datasets: status });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/data/:dataset', async (req, res) => {
  if (!auth(req, res)) return;
  const { dataset } = req.params;
  if (!VALID_DATASETS.includes(dataset)) return res.status(400).json({ success:false, error:'Unknown dataset' });
  try {
    const result = await pool.query('SELECT payload, updated_at FROM dashboard_data WHERE dataset=$1', [dataset]);
    if (!result.rows.length) return res.json({ success:true, data:null, updatedAt:null });
    res.json({ success:true, data:result.rows[0].payload, updatedAt:result.rows[0].updated_at });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

app.post('/api/data/:dataset', async (req, res) => {
  if (!auth(req, res)) return;
  const { dataset } = req.params;
  if (!VALID_DATASETS.includes(dataset)) return res.status(400).json({ success:false, error:'Unknown dataset' });
  try {
    await pool.query(`INSERT INTO dashboard_data (dataset, payload, updated_at) VALUES ($1, $2, NOW())
      ON CONFLICT (dataset) DO UPDATE SET payload=$2, updated_at=NOW()`, [dataset, JSON.stringify(req.body)]);
    res.json({ success:true, dataset, updatedAt: new Date().toISOString() });
  } catch (err) { res.status(500).json({ success:false, error:err.message }); }
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Store Health Tracker API running on port ${PORT}`);
  pool.query(`CREATE TABLE IF NOT EXISTS dashboard_data (
    dataset TEXT PRIMARY KEY, payload JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW()
  )`).then(() => console.log('DB ready')).catch(err => console.error('DB init error:', err.message));
});