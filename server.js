require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const validUrl = require('valid-url');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // optional if you add CSS/JS files

// -------------------------
// Postgres setup
// -------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// -------------------------
// Table creation
// -------------------------
const createTables = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS urls (
        id SERIAL PRIMARY KEY,
        short_code TEXT UNIQUE NOT NULL,
        original_url TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        click_count INT DEFAULT 0,
        last_clicked_at TIMESTAMPTZ
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS click_logs (
        id SERIAL PRIMARY KEY,
        url_id INT REFERENCES urls(id) ON DELETE CASCADE,
        click_time TIMESTAMPTZ DEFAULT NOW(),
        user_agent TEXT,
        ip_address TEXT
      );
    `);

    console.log('Tables created successfully!');
  } catch (err) {
    console.error('Error creating tables:', err.message);
    process.exit(1);
  }
};
createTables();

// -------------------------
// Utilities
// -------------------------
const generateShortCode = () => crypto.randomBytes(3).toString('hex');

// -------------------------
// Healthcheck
// -------------------------
app.get('/health', async (req, res) => {
  try {
    const uptime = process.uptime();
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'connected',
      uptime_seconds: uptime,
      system: {
        platform: process.platform,
        node_version: process.version,
        memory_usage: process.memoryUsage(),
      },
    });
  } catch (err) {
    res.status(503).json({ status: 'error', db: 'unreachable', error: err.message });
  }
});

// -------------------------
// Serve frontend
// -------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// -------------------------
// DB test
// -------------------------
app.get('/dbtest', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() as now');
    res.json({ success: true, now: rows[0].now });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// -------------------------
// Shorten URL
// -------------------------
app.post('/shorten', async (req, res) => {
  const { originalUrl, customCode } = req.body;

  if (!originalUrl || !validUrl.isWebUri(originalUrl)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let shortCode = customCode ? customCode.trim() : generateShortCode();

  try {
    const existing = await pool.query('SELECT * FROM urls WHERE short_code = $1', [shortCode]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Short code already exists. Try another one.' });
    }

    const result = await pool.query(
      'INSERT INTO urls (short_code, original_url) VALUES ($1, $2) RETURNING *',
      [shortCode, originalUrl]
    );

    res.json({
      shortUrl: `${BASE_URL}/${shortCode}`,
      data: result.rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create short URL' });
  }
});

// -------------------------
// Redirect
// -------------------------
app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  try {
    const result = await pool.query('SELECT * FROM urls WHERE short_code = $1', [shortCode]);
    if (result.rows.length === 0) return res.status(404).send('Short URL not found');

    const urlData = result.rows[0];

    await pool.query(
      'UPDATE urls SET click_count = click_count + 1, last_clicked_at = NOW() WHERE id = $1',
      [urlData.id]
    );

    await pool.query(
      'INSERT INTO click_logs (url_id, user_agent, ip_address) VALUES ($1, $2, $3)',
      [urlData.id, req.headers['user-agent'], req.ip]
    );

    res.redirect(302, urlData.original_url);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// -------------------------
// Delete short URL
// -------------------------
app.delete('/delete/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM urls WHERE short_code = $1 RETURNING *',
      [shortCode]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Short code not found' });
    }

    res.json({ message: `Short code ${shortCode} deleted successfully` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete short URL' });
  }
});

// -------------------------
// Dashboard API
// -------------------------
app.get('/api/dashboard', async (req, res) => {
  const search = req.query.search || '';

  try {
    const query = `
      SELECT id, short_code, original_url, click_count, last_clicked_at
      FROM urls
      WHERE short_code ILIKE $1 OR original_url ILIKE $1
      ORDER BY created_at DESC
    `;
    const values = [`%${search}%`];
    const result = await pool.query(query, values);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch links' });
  }
});

// -------------------------
// Single code stats
// -------------------------
app.get('/code/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  try {
    const urlResult = await pool.query(
      'SELECT id, short_code, original_url, click_count, last_clicked_at FROM urls WHERE short_code = $1',
      [shortCode]
    );

    if (urlResult.rows.length === 0) {
      return res.status(404).json({ error: 'Short code not found' });
    }

    const urlData = urlResult.rows[0];

    const clicksResult = await pool.query(
      'SELECT click_time, user_agent, ip_address FROM click_logs WHERE url_id = $1 ORDER BY click_time DESC',
      [urlData.id]
    );

    res.json({ url: urlData, click_logs: clicksResult.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});



// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
