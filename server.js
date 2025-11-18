require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});


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
    await pool.end();
  } catch (err) {
    console.error('Error creating tables:', err.message);
    await pool.end();
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




app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});
// Start
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});