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

// -------------------------
// Middleware
// -------------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
const isValidCode = (code) => /^[A-Za-z0-9]{6,8}$/.test(code);

// -------------------------
// Healthcheck
// -------------------------
app.get('/healthz', async (req, res) => {
  try {
    const uptime = process.uptime();
    await pool.query('SELECT 1');
    res.json({
      ok: true,
      version: '1.0',
      db: 'connected',
      uptime_seconds: uptime,
      system: {
        platform: process.platform,
        node_version: process.version,
        memory_usage: process.memoryUsage(),
      },
    });
  } catch (err) {
    res.status(503).json({ ok: false, db: 'unreachable', error: err.message });
  }
});

// -------------------------
// Frontend pages
// -------------------------
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/code/:shortCode', (req, res) => res.sendFile(path.join(__dirname, 'stats.html')));
app.get('/404', (req, res) => res.sendFile(path.join(__dirname, '404.html')));

// -------------------------
// API: Create link
// POST /api/links
// -------------------------
app.post('/api/links', async (req, res) => {
  const { originalUrl, customCode } = req.body;

  if (!originalUrl || !validUrl.isWebUri(originalUrl)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let shortCode = customCode ? customCode.trim() : generateShortCode();

  if (!isValidCode(shortCode)) {
    return res.status(400).json({ error: 'Code must be 6-8 alphanumeric characters' });
  }

  try {
    const exists = await pool.query('SELECT * FROM urls WHERE short_code = $1', [shortCode]);
    if (exists.rows.length > 0) return res.status(409).json({ error: 'Short code already exists' });

    const result = await pool.query(
      'INSERT INTO urls (short_code, original_url) VALUES ($1, $2) RETURNING *',
      [shortCode, originalUrl]
    );

    res.status(201).json({ shortUrl: `${BASE_URL}/${shortCode}`, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create short URL' });
  }
});

// -------------------------
// API: List all links
// GET /api/links
// Optional query param: search
// -------------------------
app.get('/api/links', async (req, res) => {
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
// API: Single link stats
// GET /api/links/:code
// -------------------------
app.get('/api/links/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  try {
    const urlRes = await pool.query(
      'SELECT id, short_code, original_url, click_count, last_clicked_at FROM urls WHERE short_code = $1',
      [shortCode]
    );
    if (urlRes.rows.length === 0) return res.status(404).json({ error: 'Short code not found' });

    const urlData = urlRes.rows[0];
    const clicksRes = await pool.query(
      'SELECT click_time, user_agent, ip_address FROM click_logs WHERE url_id = $1 ORDER BY click_time DESC',
      [urlData.id]
    );

    res.json({ url: urlData, click_logs: clicksRes.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// -------------------------
// API: Delete link
// DELETE /api/links/:shortCode
// -------------------------
app.delete('/api/links/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  try {
    const result = await pool.query('DELETE FROM urls WHERE short_code = $1 RETURNING *', [shortCode]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Short code not found' });
    res.json({ message: `Short code ${shortCode} deleted successfully` });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete link' });
  }
});

// -------------------------
// Redirect
// GET /:code
// -------------------------
app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;
  try {
    const result = await pool.query('SELECT * FROM urls WHERE short_code = $1', [shortCode]);
    if (result.rows.length === 0) return res.redirect('/404');

    const urlData = result.rows[0];

    // Increment click count & log
    await pool.query('UPDATE urls SET click_count = click_count + 1, last_clicked_at = NOW() WHERE id = $1', [urlData.id]);
    await pool.query('INSERT INTO click_logs (url_id, user_agent, ip_address) VALUES ($1, $2, $3)', [
      urlData.id,
      req.headers['user-agent'],
      req.ip,
    ]);

    res.redirect(302, urlData.original_url);
  } catch (err) {
    res.status(500).send('Server error');
  }
});

// -------------------------
// Start server
// -------------------------
app.listen(PORT, () => {
  console.log(`Server running at ${BASE_URL}`);
});
