/**
 * api.mjs — Website Scorer API + static file server
 *
 * Serves index.html and handles:
 *   GET /api/search?location=&industry=&limit=
 *   GET /api/industries
 *
 * Usage: node api.mjs
 */

import { createServer }  from 'http';
import { readFileSync, existsSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';
import { findBusinesses, scoreAll, detectLocation, ALL_INDUSTRIES } from './find-worst-websites.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const PORT  = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.mjs':  'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

function jsonError(res, status, message) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify({ error: message }));
}

// ─── Request handler ──────────────────────────────────────────────────────────

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' });
    return res.end();
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/search')     return handleSearch(res, url);
  if (url.pathname === '/api/industries') return handleIndustries(res);

  // Static file fallback
  const relPath  = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const filePath = join(__dir, relPath);

  if (!existsSync(filePath) || filePath.includes('..')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }

  const mime = MIME[extname(filePath)] ?? 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  res.end(readFileSync(filePath));

}).listen(PORT, () => {
  console.log(`\nWebsite Scorer running → http://localhost:${PORT}\n`);
});

// ─── GET /api/industries ──────────────────────────────────────────────────────

function handleIndustries(res) {
  res.writeHead(200, JSON_HEADERS);
  res.end(JSON.stringify(ALL_INDUSTRIES));
}

// ─── GET /api/search ──────────────────────────────────────────────────────────

async function handleSearch(res, url) {
  const locationParam = url.searchParams.get('location')?.trim() || null;
  const industryParam = url.searchParams.get('industry')?.trim() || null;
  const limit         = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit') || '25', 10)));

  const googleApiKey = process.env.GOOGLE_API_KEY  || null;
  const psiApiKey    = process.env.PSI_API_KEY      || googleApiKey || null;
  const anthropicKey = process.env.ANTHROPIC_API_KEY || null;
  const industries   = industryParam ? [industryParam] : ALL_INDUSTRIES;

  let location = locationParam;
  if (!location) {
    try { location = await detectLocation(); }
    catch { location = 'New York, USA'; }
  }

  try {
    const collectTarget = Math.min(limit * 3, 300);
    const businesses    = await findBusinesses(location, industries, collectTarget, googleApiKey);

    if (businesses.length === 0) {
      return jsonError(res, 404, `No businesses with websites found for "${location}". Try a different location or industry.`);
    }

    const results = await scoreAll(businesses, psiApiKey, anthropicKey, limit);

    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({
      location,
      generatedAt: new Date().toISOString(),
      total: results.length,
      results,
    }));
  } catch (e) {
    console.error('[API] Search error:', e.message);
    jsonError(res, 500, e.message);
  }
}
