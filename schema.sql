-- urls table: stores mapping and aggregate analytics
CREATE TABLE IF NOT EXISTS urls (
id SERIAL PRIMARY KEY,
short_code TEXT UNIQUE NOT NULL,
original_url TEXT NOT NULL,
created_at TIMESTAMP WITHOUT TIME ZONE DEFAULT (NOW() AT TIME ZONE 'utc'),
last_click_at TIMESTAMP WITHOUT TIME ZONE,
click_count BIGINT DEFAULT 0,
title TEXT
);