const express = require('express');
const cors    = require('cors');
const { Pool } = require('pg');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'], allowedHeaders: '*' }));
app.options('*', cors());
app.use(express.json({ limit: '50mb' }));

// ── Database ──────────────────────────────────────────────────────────────────
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const pool = new Pool({
  host: 'acela.proxy.rlwy.net',
  port: 32558,
  database: 'railway',
  user: 'postgres',
  password: 'uNTumoOKwvZcHLMNcPXJnZGRGGGgfDbV',
});

app.listen(PORT, () => {
  console.log(`Dashboard API running on port ${PORT}`);
  // Init DB after server is listening
  pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_data (
      dataset    TEXT PRIMARY KEY,
      payload    JSONB        NOT NULL,
      updated_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `).then(() => console.log('DB ready'))
    .catch(err => console.error('DB init error:', err.message, err.code));
});
const VALID_DATASETS = ['mapping','od','invreport','compreport','plreport','inbound'];
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

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Store Health Tracker API',
    pwd_configured: true,
  });
});

// Temp debug
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