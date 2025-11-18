require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
});

app.use(express.json());

app.get('/healthz', async (req, res) => {
  try {
    // simple DB ping
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ok', db: 'connected' });
  } catch (err) {
    console.error('Health check DB error:', err.message || err);
    res.status(503).json({ status: 'error', db: 'unreachable', error: err.message });
  }
});

// DB test endpoint - returns server time from DB
app.get('/dbtest', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() as now');
    res.json({ success: true, now: rows[0].now });
  } catch (err) {
    console.error('DB test error:', err.message || err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/', (req, res) => res.send('TinyURL server - DB connection ready'));

// Start
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});