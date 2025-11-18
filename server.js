require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');
const validUrl = require('valid-url');
const app = express();
const PORT = process.env.PORT || 3000;
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});
const BASE_URL = process.env.BASE_URL

const generateShortCode = () => crypto.randomBytes(3).toString('hex');

const createTables = async () => {
  try {
    // URLs table
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

    // Click logs table
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

// -------------------------
// Shorten URL endpoint
// -------------------------
app.post('/shorten', async (req, res) => {
  const { originalUrl, customCode } = req.body;

  // 1️⃣ Validate URL
  if (!originalUrl || !validUrl.isWebUri(originalUrl)) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  let shortCode = customCode ? customCode.trim() : generateShortCode();

  try {
    // 2️⃣ Check if short code already exists
    const existing = await pool.query('SELECT * FROM urls WHERE short_code = $1', [shortCode]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Short code already exists. Try another one.' });
    }

    // 3️⃣ Insert into DB
    const result = await pool.query(
      'INSERT INTO urls (short_code, original_url) VALUES ($1, $2) RETURNING *',
      [shortCode, originalUrl]
    );

    res.json({
      shortUrl: `${BASE_URL}/${shortCode}`,
      data: result.rows[0]
    });
  } catch (err) {
    console.error('Error creating short URL:', err.message);
    res.status(500).json({ error: 'Failed to create short URL' });
  }
});


// -------------------------
// Redirect endpoint
// -------------------------
app.get('/:shortCode', async (req, res) => {
  const { shortCode } = req.params;

  try {
    const result = await pool.query('SELECT * FROM urls WHERE short_code = $1', [shortCode]);

    if (result.rows.length === 0) return res.status(404).send('Short URL not found');

    const urlData = result.rows[0];

    // 1️⃣ Update click count & last clicked time
    await pool.query(
      'UPDATE urls SET click_count = click_count + 1, last_clicked_at = NOW() WHERE id = $1',
      [urlData.id]
    );

    // 2️⃣ Optional: log click details
    await pool.query(
      'INSERT INTO click_logs (url_id, user_agent, ip_address) VALUES ($1, $2, $3)',
      [urlData.id, req.headers['user-agent'], req.ip]
    );

    // 3️⃣ Redirect
    res.redirect(302, urlData.original_url);
  } catch (err) {
    console.error('Error during redirect:', err.message);
    res.status(500).send('Server error');
  }
});




app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
// Start
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});