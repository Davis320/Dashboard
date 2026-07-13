const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { Pool } = require('pg');
const sp      = require('./sp');
 
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
    const data = await sp.getPrice(asin);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
 
// GET /sp/fees?asin=B001234&price=14.99&pwd=...
app.get('/sp/fees', async (req, res) => {
  if (!auth(req, res)) return;
  const { asin, price } = req.query;
  if (!asin || !price) return res.status(400).json({ success: false, error: 'asin and price required' });
  try {
    const data = await sp.getFees(asin, +price);
    res.json({ success: true, data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
 
// GET /sp/inventory?pwd=...  — all FBA inventory
app.get('/sp/inventory', async (req, res) => {
  if (!auth(req, res)) return;
  try {
    const items = await sp.getAllInventory();
    res.json({ success: true, count: items.length, items });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
 
// GET /sp/orders?days=30&pwd=...
app.get('/sp/orders', async (req, res) => {
  if (!auth(req, res)) return;
  const days = Math.min(+(req.query.days || 30), 180);
  try {
    const data = await sp.getOrders(days);
    res.json({ success: true, ...data });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});
 
// GET /sp/sku-summary?sku=XX&asin=B0...&pwd=...  — combined for tooltip
app.get('/sp/sku-summary', async (req, res) => {
  if (!auth(req, res)) return;
  const { sku, asin } = req.query;
  if (!sku && !asin) return res.status(400).json({ success: false, error: 'sku or asin required' });
  try {
    const data = await sp.getSkuSummary(sku, asin);
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