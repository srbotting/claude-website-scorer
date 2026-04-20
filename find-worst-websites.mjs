#!/usr/bin/env node
/**
 * find-worst-websites.mjs
 *
 * Discovers local businesses and scores their websites to find the worst performers.
 *
 * Discovery (automatic fallback):
 *   1. Google Places API   — requires GOOGLE_API_KEY, paid per call
 *   2. OpenStreetMap/Overpass — completely free, no key needed
 *
 * Scoring (automatic fallback):
 *   1. PageSpeed Insights  — requires PSI_API_KEY (or GOOGLE_API_KEY), paid
 *   2. Puppeteer local audit — free, uses the bundled Chrome, no external API
 *
 * Usage:
 *   node find-worst-websites.mjs [options]
 *
 * Options:
 *   --location <loc>    Where to search (default: auto-detect from IP)
 *   --industry <ind>    Single industry/trade (default: all industries)
 *   --limit <n>         Max results to return (default: 100)
 *   --output <file>     Save full results to JSON file
 *   --api-key <key>     Google API key (or set GOOGLE_API_KEY in .env)
 *   --help              Show this help
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __dir = dirname(fileURLToPath(import.meta.url));
loadEnv(join(__dir, '.env'));

// ─── Constants ────────────────────────────────────────────────────────────────

const PLACES_BASE  = 'https://maps.googleapis.com/maps/api/place';
const PSI_BASE     = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed';
const IPGEO_URL    = 'https://ipapi.co/json/';
const NOMINATIM    = 'https://nominatim.openstreetmap.org/search';
const OVERPASS     = 'https://overpass-api.de/api/interpreter';
const OSM_UA       = 'website-scorer/1.0 (srbotting@gmail.com)';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// Module-level flag — set to false if Anthropic key is rejected mid-run
let anthropicKeyValid = true;

const ALL_INDUSTRIES = [
  'plumber', 'electrician', 'hvac contractor', 'roofing contractor',
  'painter', 'landscaper', 'restaurant', 'dentist', 'lawyer',
  'accountant', 'mechanic', 'florist', 'hair salon', 'real estate agent',
  'cleaning service', 'pest control', 'locksmith', 'photographer',
  'veterinarian', 'chiropractor', 'optometrist', 'gym', 'bakery',
  'towing service', 'auto body shop', 'carpet cleaner', 'pool service',
  'tree service', 'fencing contractor', 'concrete contractor',
];

// OpenStreetMap tag mappings per industry
const OSM_TAGS = {
  'plumber':             [['craft','plumber'], ['shop','plumber']],
  'electrician':         [['craft','electrician']],
  'hvac contractor':     [['craft','hvac'], ['craft','heating_engineer']],
  'roofing contractor':  [['craft','roofer']],
  'painter':             [['craft','painter']],
  'landscaper':          [['craft','gardener'], ['shop','garden_centre']],
  'restaurant':          [['amenity','restaurant']],
  'dentist':             [['amenity','dentist']],
  'lawyer':              [['office','lawyer']],
  'accountant':          [['office','accountant']],
  'mechanic':            [['shop','car_repair']],
  'florist':             [['shop','florist']],
  'hair salon':          [['shop','hairdresser'], ['shop','beauty']],
  'real estate agent':   [['office','estate_agent']],
  'cleaning service':    [['craft','cleaning']],
  'pest control':        [['craft','pest_control']],
  'locksmith':           [['craft','locksmith'], ['shop','locksmith']],
  'photographer':        [['shop','photographer']],
  'veterinarian':        [['amenity','veterinary']],
  'chiropractor':        [['healthcare','chiropractor']],
  'optometrist':         [['shop','optician'], ['healthcare','optometrist']],
  'gym':                 [['leisure','fitness_centre']],
  'bakery':              [['shop','bakery']],
  'towing service':      [['shop','car_repair']],
  'auto body shop':      [['shop','car_repair']],
  'carpet cleaner':      [['craft','cleaning']],
  'pool service':        [['craft','swimming_pool']],
  'tree service':        [['craft','arborist']],
  'fencing contractor':  [['craft','fencer']],
  'concrete contractor': [['craft','concreter']],
};

// ─── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(raw) {
  const out = {};
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].startsWith('--')) {
      const key = raw[i].slice(2);
      const next = raw[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    }
  }
  return out;
}

function showHelp() {
  console.log(`
Usage: node find-worst-websites.mjs [options]

  --location <loc>    Where to search (default: auto-detect from IP)
  --industry <ind>    Single industry to search (default: all ${ALL_INDUSTRIES.length} industries)
  --limit <n>         Max results to return (default: 100)
  --output <file>     Save results to JSON file
  --api-key <key>     Google API key (or set GOOGLE_API_KEY in .env)
  --help              Show this help

No API key? Runs fully free using OpenStreetMap + Puppeteer.
With GOOGLE_API_KEY: uses Google Places + PageSpeed Insights for best results.

Cost estimate with Google key (100 results): ~$1–5 USD in Places API calls.
`);
}

// ─── .env Loader ─────────────────────────────────────────────────────────────

function loadEnv(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[k]) process.env[k] = v;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = msg => console.log(msg);

function truncate(str, len) {
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function pad(val, len, right = false) {
  const s = String(val);
  return right ? s.padStart(len) : s.padEnd(len);
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

function normaliseUrl(raw) {
  try {
    const u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    return u.href;
  } catch { return null; }
}

function hostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); }
  catch { return null; }
}

// ─── Location Detection ───────────────────────────────────────────────────────

async function detectLocation() {
  log('Detecting location from IP...');
  try {
    const data = await fetchJson(IPGEO_URL);
    if (data.city && data.country_name) {
      const loc = `${data.city}, ${data.country_name}`;
      log(`  Detected: ${loc}`);
      return loc;
    }
  } catch (e) {
    log(`  Could not detect location (${e.message}), falling back to New York, USA`);
  }
  return 'New York, USA';
}

// ─── Discovery: Google Places ─────────────────────────────────────────────────

async function placesTextSearch(query, apiKey, pageToken = null) {
  const params = new URLSearchParams({ key: apiKey });
  if (pageToken) params.set('pagetoken', pageToken);
  else           params.set('query', query);
  return fetchJson(`${PLACES_BASE}/textsearch/json?${params}`);
}

async function placeDetails(placeId, apiKey) {
  const params = new URLSearchParams({ place_id: placeId, fields: 'name,website,formatted_address', key: apiKey });
  const data = await fetchJson(`${PLACES_BASE}/details/json?${params}`);
  return data.result ?? null;
}

async function findBusinessesGoogle(location, industries, targetCount, apiKey) {
  const seen = new Map();
  const maxPerIndustry = Math.max(5, Math.ceil(targetCount / industries.length));

  for (const industry of industries) {
    if (seen.size >= targetCount) break;
    const query = `${industry} in ${location}`;
    process.stdout.write(`  ${truncate(query, 55).padEnd(55)} `);

    let found = 0, pageToken = null, page = 0;

    try {
      while (found < maxPerIndustry && page < 3) {
        if (pageToken) await sleep(2100);
        const data = pageToken
          ? await placesTextSearch(null, apiKey, pageToken)
          : await placesTextSearch(query, apiKey);

        if (data.status === 'REQUEST_DENIED' || data.status === 'INVALID_REQUEST') {
          const err = Object.assign(new Error(data.error_message || data.status), { code: 'API_KEY_INVALID' });
          throw err;
        }
        if (data.status === 'ZERO_RESULTS') break;

        for (const place of data.results ?? []) {
          if (found >= maxPerIndustry || seen.size >= targetCount) break;
          const details = await placeDetails(place.place_id, apiKey);
          await sleep(60);
          if (!details?.website) continue;
          const h = hostname(details.website);
          if (h && !seen.has(h)) {
            seen.set(h, { name: details.name ?? place.name, website: details.website, address: details.formatted_address ?? '', industry });
            found++;
          }
        }

        pageToken = data.next_page_token ?? null;
        if (!pageToken) break;
        page++;
      }
    } catch (e) {
      process.stdout.write(`FAIL (${e.message})\n`);
      if (e.code === 'API_KEY_INVALID') throw e; // bubble up so caller can fall back
      continue;
    }

    process.stdout.write(`${found} found  (total: ${seen.size})\n`);
  }

  return Array.from(seen.values());
}

// ─── Discovery: OpenStreetMap / Overpass ─────────────────────────────────────

async function geocode(location) {
  const url = `${NOMINATIM}?q=${encodeURIComponent(location)}&format=json&limit=1`;
  const data = await fetchJson(url, { headers: { 'User-Agent': OSM_UA } });
  if (!data[0]) throw new Error(`Could not geocode "${location}" via Nominatim`);
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
}

async function overpassQuery(tagPairs, lat, lon, radiusM) {
  const lines = tagPairs
    .map(([k, v]) => `node["${k}"="${v}"]["website"](around:${radiusM},${lat},${lon});`)
    .join('\n  ');
  const ql = `[out:json][timeout:60];\n(\n  ${lines}\n);\nout body;`;

  const res = await fetch(OVERPASS, {
    method: 'POST',
    body: `data=${encodeURIComponent(ql)}`,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': OSM_UA },
    signal: AbortSignal.timeout(65_000),
  });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return res.json();
}

async function findBusinessesOSM(location, industries, targetCount) {
  log('\n  Geocoding location via Nominatim...');
  const { lat, lon } = await geocode(location);
  log(`  Geocoded to: ${lat.toFixed(4)}, ${lon.toFixed(4)}`);

  const seen = new Map();

  for (const industry of industries) {
    if (seen.size >= targetCount) break;
    const tags = OSM_TAGS[industry];
    if (!tags) continue;

    process.stdout.write(`  ${industry.padEnd(30)} `);

    try {
      const data = await overpassQuery(tags, lat, lon, 20_000); // 20 km radius
      let found = 0;
      for (const el of data.elements ?? []) {
        const web = el.tags?.website ? normaliseUrl(el.tags.website) : null;
        if (!web) continue;
        const h = hostname(web);
        if (h && !seen.has(h)) {
          seen.set(h, {
            name: el.tags.name ?? `${industry}`,
            website: web,
            address: [el.tags['addr:housenumber'], el.tags['addr:street'], el.tags['addr:city']].filter(Boolean).join(' '),
            industry,
          });
          found++;
        }
      }
      process.stdout.write(`${found} found  (total: ${seen.size})\n`);
    } catch (e) {
      process.stdout.write(`ERROR (${e.message})\n`);
    }

    await sleep(1200); // Overpass fair-use: max 1 req/s
  }

  return Array.from(seen.values());
}

// Unified discovery with automatic fallback
async function findBusinesses(location, industries, targetCount, googleApiKey) {
  log(`\nDiscovering businesses in: ${location}`);
  log(`Industries: ${industries.length === ALL_INDUSTRIES.length ? `all (${ALL_INDUSTRIES.length})` : industries.join(', ')}`);

  if (googleApiKey) {
    log('\n[Discovery] Trying Google Places API...');
    try {
      const results = await findBusinessesGoogle(location, industries, targetCount, googleApiKey);
      if (results.length > 0) {
        log(`\n[Discovery] Google Places: found ${results.length} businesses.`);
        return results;
      }
      log('[Discovery] Google Places returned no results — falling back to OpenStreetMap.');
    } catch (e) {
      const reason = e.code === 'API_KEY_INVALID' ? 'key invalid/denied' : e.message;
      log(`[Discovery] Google Places unavailable (${reason}) — falling back to OpenStreetMap.`);
    }
  } else {
    log('[Discovery] No Google API key — using OpenStreetMap (free).');
  }

  log('[Discovery] Querying OpenStreetMap / Overpass...');
  const results = await findBusinessesOSM(location, industries, targetCount);
  log(`\n[Discovery] OpenStreetMap: found ${results.length} businesses.`);
  return results;
}

// ─── Design scoring ───────────────────────────────────────────────────────────

function computeDesignScore(d) {
  // Base of 35 = "we don't know yet". Passing all modern checks peaks at ~84,
  // deliberately leaving 85-100 unreachable by heuristics alone so vision
  // scores don't collide with heuristic noise.
  let score = 35;
  // Deductions for legacy / archaic patterns
  if (d.hasFrames)                                         score -= 30;
  if (d.hasMarquee)                                        score -= 20;
  if (d.centerTags > 2)                                    score -= Math.min(15, d.centerTags * 3);
  if (d.fontTags > 3)                                      score -= Math.min(15, d.fontTags * 3);
  if (d.legacyTables > 3 && !d.hasFlexbox && !d.hasGrid)  score -= 20;
  if (!d.hasMediaQueries)                                  score -= 15;
  if (d.isLegacyFont)                                      score -= 10;
  if (d.hasFixedWidth)                                     score -= 10;
  // Additions for modern patterns (max +49 → peak 84)
  if (d.hasFlexbox || d.hasGrid)   score += 12;
  if (d.hasGrid)                   score += 4;  // extra credit: grid is more deliberate than flex
  if (d.hasMediaQueries)           score += 10;
  if (d.hasWebFonts)               score += 8;
  if (d.hasCSSVars)                score += 8;
  if (d.hasBorderRadius)           score += 4;
  if (d.hasTransitions)            score += 3;
  return Math.max(0, Math.min(100, Math.round(score)));
}

async function scoreDesignVision(jpegBase64, anthropicKey) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpegBase64 } },
          { type: 'text', text: 'Score this website\'s visual design modernity 0-100: 0=extremely outdated (1990s/2000s), 100=very modern. Judge colors, typography, layout, whitespace. Reply JSON only: {"score":<number>}' },
        ],
      }],
    }),
    signal: AbortSignal.timeout(25_000),
  });

  if (res.status === 401 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body?.error?.message ?? `HTTP ${res.status}`), { code: 'ANTHROPIC_KEY_INVALID' });
  }
  if (!res.ok) return null;

  const data = await res.json();
  const txt  = data.content?.[0]?.text ?? '';
  const m    = txt.match(/\{[^}]+\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]);
    return Math.max(0, Math.min(100, Math.round(Number(parsed.score) || 50)));
  } catch { return null; }
}

// ─── Scoring: PageSpeed Insights ─────────────────────────────────────────────

async function scorePSI(url, apiKey) {
  const cats = ['performance', 'accessibility', 'best-practices', 'seo'];
  const catStr = cats.map(c => `category=${encodeURIComponent(c)}`).join('&');
  const endpoint = `${PSI_BASE}?url=${encodeURIComponent(url)}&strategy=mobile&${catStr}${apiKey ? `&key=${apiKey}` : ''}`;

  const res = await fetch(endpoint, { signal: AbortSignal.timeout(60_000) });

  // Detect API key rejection explicitly
  if (res.status === 400 || res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.error?.message ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { code: 'PSI_KEY_INVALID' });
  }
  if (!res.ok) return null;

  const data = await res.json();
  const cats_r = data.lighthouseResult?.categories;
  if (!cats_r) return null;

  const get = k => Math.round((cats_r[k]?.score ?? 0) * 100);
  const performance   = get('performance');
  const accessibility = get('accessibility');
  const bestPractices = get('best-practices');
  const seo           = get('seo');

  return { performance, accessibility, bestPractices, seo, overall: Math.round((performance + accessibility + bestPractices + seo) / 4), method: 'psi' };
}

// ─── Scoring: Puppeteer local audit ──────────────────────────────────────────

async function scorePuppeteer(url, browser, anthropicKey = null) {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.resourceType() === 'font') req.abort();
    else req.continue();
  });

  let navOk = false;
  const t0 = Date.now();
  try {
    const res   = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    const status = res?.status() ?? 0;
    // Treat HTTP error responses as failed — prevents scoring Google/Cloudflare error pages
    navOk = status === 0 || (status >= 200 && status < 400);
  } catch { /* timed out or failed */ }
  const loadMs = Date.now() - t0;

  if (!navOk) {
    await page.close();
    return { performance: 0, accessibility: 0, bestPractices: 0, seo: 0, design: 0, overall: 0, method: 'puppeteer', designMethod: 'heuristic' };
  }

  let audit, screenshotB64 = null;
  try {
    audit = await page.evaluate(() => {
      const imgs    = [...document.querySelectorAll('img')];
      const inputs  = [...document.querySelectorAll('input:not([type=hidden]), select, textarea')];
      const labeled = inputs.filter(el => (el.id && document.querySelector(`label[for="${el.id}"]`)) || el.closest('label')).length;

      // Read accessible stylesheet rules for CSS feature detection
      let css = '';
      for (const sheet of [...document.styleSheets]) {
        try { css += [...sheet.cssRules].map(r => r.cssText).join(' '); } catch {}
      }
      // Also check computed display on a sample of layout elements
      const layoutEls = [...document.querySelectorAll('div,section,main,header,footer,nav,ul')].slice(0, 40);
      const hasFlexbox = /display\s*:\s*(?:flex|inline-flex)/i.test(css) ||
        layoutEls.some(el => { const d = getComputedStyle(el).display; return d === 'flex' || d === 'inline-flex'; });
      const hasGrid = /display\s*:\s*(?:grid|inline-grid)/i.test(css) ||
        layoutEls.some(el => { const d = getComputedStyle(el).display; return d === 'grid' || d === 'inline-grid'; });

      const visibleText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
      const wordCount   = visibleText ? visibleText.split(' ').filter(w => w.length > 1).length : 0;

      return {
        wordCount,
        hasTitle:      !!document.title?.trim(),
        hasMetaDesc:   !!document.querySelector('meta[name="description"]')?.content?.trim(),
        hasViewport:   !!document.querySelector('meta[name="viewport"]'),
        hasCanonical:  !!document.querySelector('link[rel="canonical"]'),
        hasH1:         !!document.querySelector('h1'),
        imgCount:      imgs.length,
        imgsWithAlt:   imgs.filter(i => i.getAttribute('alt') !== null).length,
        hasLang:       !!document.documentElement.lang,
        inputCount:    inputs.length,
        labeledInputs: labeled,
        hasFavicon:    !!(document.querySelector('link[rel="icon"]') || document.querySelector('link[rel="shortcut icon"]')),
        hasDoctype:    !!document.doctype,
        design: {
          legacyTables:    document.querySelectorAll('table').length,
          centerTags:      document.querySelectorAll('center').length,
          fontTags:        document.querySelectorAll('font').length,
          hasFrames:       !!document.querySelector('frame, frameset'),
          hasMarquee:      !!document.querySelector('marquee, blink'),
          hasFlexbox,
          hasGrid,
          hasMediaQueries: /@media\b/i.test(css),
          hasCSSVars:      /--[\w-]+\s*:/.test(css),
          hasBorderRadius: /border-radius/.test(css),
          hasTransitions:  /\btransition\b/.test(css),
          hasWebFonts:     /@font-face\b/i.test(css) ||
            !!document.querySelector('link[href*="fonts.google"],link[href*="typekit"],link[href*="fonts.adobe"]'),
          isLegacyFont:    /comic\s+sans|times\s+new\s+roman|courier\s+new/i.test(
            getComputedStyle(document.body).fontFamily),
          hasFixedWidth: (() => {
            const w = getComputedStyle(document.body).maxWidth;
            return /^\d+px$/.test(w) && parseInt(w) < 1100;
          })(),
        },
      };
    });

    if (anthropicKey && anthropicKeyValid) {
      screenshotB64 = (await page.screenshot({ type: 'jpeg', quality: 55 })).toString('base64');
    }
  } catch {
    await page.close();
    return { performance: 5, accessibility: 5, bestPractices: 5, seo: 5, design: 5, overall: 5, method: 'puppeteer', designMethod: 'heuristic' };
  }

  await page.close();

  // Parked domains, "coming soon" pages, and soft 404s have almost no real content
  if (audit.wordCount < 30) {
    return { performance: 0, accessibility: 0, bestPractices: 0, seo: 0, design: 0, overall: 0, method: 'puppeteer', designMethod: 'heuristic' };
  }

  const isHttps = url.startsWith('https://');

  const perf =
    loadMs < 1500 ? 88 :
    loadMs < 3000 ? 70 :
    loadMs < 5000 ? 50 :
    loadMs < 8000 ? 30 : 12;

  const seo = Math.min(100,
    (audit.hasTitle    ? 25 : 0) +
    (audit.hasMetaDesc ? 25 : 0) +
    (audit.hasViewport ? 25 : 0) +
    (audit.hasCanonical? 15 : 0) +
    (audit.hasH1       ? 10 : 0),
  );

  const altRatio   = audit.imgCount   > 0 ? audit.imgsWithAlt   / audit.imgCount   : 1;
  const labelRatio = audit.inputCount > 0 ? audit.labeledInputs / audit.inputCount : 1;
  const a11y = Math.min(100, Math.round(
    (audit.hasLang ? 30 : 0) + altRatio * 45 + labelRatio * 25,
  ));

  const bp = Math.min(100,
    (isHttps ? 45 : 0) + (audit.hasFavicon ? 20 : 0) + (audit.hasDoctype ? 20 : 0) + 15,
  );

  let design = computeDesignScore(audit.design);
  let designMethod = 'heuristic';

  if (anthropicKey && anthropicKeyValid && screenshotB64) {
    try {
      const visionScore = await scoreDesignVision(screenshotB64, anthropicKey);
      if (visionScore !== null) {
        design = Math.round(visionScore * 0.75 + design * 0.25);
        designMethod = 'vision';
      }
    } catch (e) {
      if (e.code === 'ANTHROPIC_KEY_INVALID') {
        log('\n  [Design] Anthropic API key invalid — using heuristics for all remaining sites.');
        anthropicKeyValid = false;
      }
    }
  }

  const overall = Math.round((perf + a11y + bp + seo + design) / 5);
  return { performance: perf, accessibility: a11y, bestPractices: bp, seo, design, overall, method: 'puppeteer', designMethod };
}

// ─── Unified scoring with fallback ───────────────────────────────────────────

async function scoreAll(businesses, psiApiKey, anthropicKey, limit) {
  let usePSI       = !!psiApiKey;
  let psiKeyBad    = false;
  let browser      = null;
  const results    = [];
  const DELAY_PSI  = 450; // ms between PSI requests

  log(`\nScoring ${businesses.length} websites...`);
  if (usePSI) log('[Scoring] Using PageSpeed Insights (API key).');
  else        log('[Scoring] No PSI key — using Puppeteer local audit.');
  if (anthropicKey) log('[Design]  Claude Vision enabled (ANTHROPIC_API_KEY set).');
  else              log('[Design]  Using CSS/DOM heuristics (set ANTHROPIC_API_KEY for visual scoring).');

  const launchBrowser = async () => {
    if (browser) return;
    log('[Scoring] Launching Puppeteer...');
    // Prefer full Chrome; fall back to chrome-headless-shell if full Chrome not downloaded
    const defaultExe = puppeteer.executablePath();
    const hsDir = defaultExe.replace(/chrome[/\\]win64/, 'chrome-headless-shell/win64').replace(/chrome-win64[/\\]chrome\.exe$/, 'chrome-headless-shell-win64/chrome-headless-shell.exe');
    const executablePath = existsSync(defaultExe) ? defaultExe : (existsSync(hsDir) ? hsDir : undefined);
    browser = await puppeteer.launch({ headless: true, executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  };

  // Launch browser immediately if we know we need it
  if (!usePSI) await launchBrowser();

  try {
    for (let i = 0; i < businesses.length; i++) {
      const biz = businesses[i];
      const label = truncate(biz.website, 58).padEnd(58);
      process.stdout.write(`  [${String(i + 1).padStart(String(businesses.length).length)}/${businesses.length}] ${label} `);

      let scores = null;

      if (usePSI && !psiKeyBad) {
        try {
          scores = await scorePSI(biz.website, psiApiKey);
          if (scores) await sleep(DELAY_PSI);
        } catch (e) {
          if (e.code === 'PSI_KEY_INVALID') {
            process.stdout.write('\n[Scoring] PSI key invalid — switching to Puppeteer for all remaining sites.\n');
            psiKeyBad = true;
            usePSI = false;
            await launchBrowser();
          }
        }
      }

      // Puppeteer: either as planned or as fallback after PSI failure
      if (!scores && browser) {
        scores = await scorePuppeteer(biz.website, browser, anthropicKey);
      }

      if (!scores) {
        process.stdout.write('SKIP\n');
        continue;
      }

      process.stdout.write(`${String(scores.overall).padStart(3)}/100  [${scores.method}]\n`);
      results.push({ ...biz, scores });
    }
  } finally {
    if (browser) await browser.close();
  }

  results.sort((a, b) => a.scores.overall - b.scores.overall);
  return results.slice(0, limit);
}

// ─── Output ───────────────────────────────────────────────────────────────────

function printTable(results, location) {
  const W    = { rank: 4, name: 28, industry: 22, perf: 5, a11y: 5, bp: 5, seo: 5, design: 7, score: 6, method: 9 };
  const LINE = '═'.repeat(160);
  const DIV  = '─'.repeat(160);

  const hasDesign   = results.some(r => r.scores.design != null);
  const designModes = [...new Set(results.map(r => r.scores.designMethod).filter(Boolean))];
  const notes = [];
  if (results.some(r => r.scores.method === 'puppeteer'))
    notes.push('  * Technical scores (Perf/A11y/BP/SEO) = load-time + HTML heuristics, not full Lighthouse');
  if (designModes.includes('heuristic'))
    notes.push('  * Design (heuristic) = CSS/DOM pattern analysis — set ANTHROPIC_API_KEY for visual AI scoring');
  if (designModes.includes('vision'))
    notes.push('  * Design (vision) = Claude AI visual assessment blended with heuristics');

  // Warn when heuristic design scores are suspiciously uniform (modern sites all pass the same checks)
  if (designModes.includes('heuristic') && !designModes.includes('vision') && results.length >= 3) {
    const dScores = results.map(r => r.scores.design).filter(v => v != null);
    const range   = Math.max(...dScores) - Math.min(...dScores);
    const avg     = dScores.reduce((a, b) => a + b, 0) / dScores.length;
    if (range <= 10 || avg >= 70)
      notes.push('  ⚠  Design scores are uniform — modern sites all pass CSS checks. Add ANTHROPIC_API_KEY for real visual scoring.');
  }

  log(`\n${LINE}`);
  log(`  WORST WEBSITES  ·  ${location}  ·  ${results.length} results`);
  notes.forEach(n => log(n));
  log(LINE);
  log([
    pad('#',        W.rank,    false),
    pad('Business', W.name,    false),
    pad('Industry', W.industry,false),
    pad('Perf',     W.perf,    true),
    pad('A11y',     W.a11y,    true),
    pad('BP',       W.bp,      true),
    pad('SEO',      W.seo,     true),
    pad('Design',   W.design,  true),
    pad('Score',    W.score,   true),
    pad('Method',   W.method,  false),
    'Website',
  ].join('  '));
  log(DIV);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const s = r.scores;
    const designStr = s.design != null ? `${s.design}${s.designMethod === 'vision' ? '✓' : ''}` : '-';
    log([
      pad(i + 1,                            W.rank,    false),
      pad(truncate(r.name, W.name),         W.name,    false),
      pad(truncate(r.industry, W.industry), W.industry,false),
      pad(s.performance,                    W.perf,    true),
      pad(s.accessibility,                  W.a11y,    true),
      pad(s.bestPractices,                  W.bp,      true),
      pad(s.seo,                            W.seo,     true),
      pad(designStr,                        W.design,  true),
      pad(s.overall,                        W.score,   true),
      pad(s.method,                         W.method,  false),
      r.website,
    ].join('  '));
  }

  log(LINE);
  const avg = results.length
    ? Math.round(results.reduce((sum, r) => sum + r.scores.overall, 0) / results.length)
    : 0;
  log(`  Average score: ${avg}/100  (lower = worse)${hasDesign ? '  ·  Design column included in Score' : ''}`);
  log(LINE);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) { showHelp(); process.exit(0); }

  const googleApiKey  = args['api-key'] || process.env.GOOGLE_API_KEY || null;
  const psiApiKey     = process.env.PSI_API_KEY || googleApiKey || null;
  const anthropicKey  = process.env.ANTHROPIC_API_KEY || null;
  const limit        = Math.max(1, parseInt(args.limit ?? '100', 10));
  const outputFile   = args.output ?? null;
  const industries   = args.industry ? [args.industry] : ALL_INDUSTRIES;

  let location = args.location ?? null;
  if (!location) location = await detectLocation();

  if (!googleApiKey) {
    log('\nNo GOOGLE_API_KEY set. Running fully free (OpenStreetMap + Puppeteer).');
    log('OSM has sparser coverage than Google — expect fewer results.\n');
  }

  const collectTarget = Math.min(limit * 3, 500);
  const businesses    = await findBusinesses(location, industries, collectTarget, googleApiKey);

  if (businesses.length === 0) {
    log('\nNo businesses with websites found. Try a different location or industry.');
    process.exit(1);
  }

  const results = await scoreAll(businesses, psiApiKey, anthropicKey, limit);
  printTable(results, location);

  if (outputFile) {
    writeFileSync(outputFile, JSON.stringify({ location, generatedAt: new Date().toISOString(), scoringMethods: [...new Set(results.map(r => r.scores.method))], results }, null, 2));
    log(`\nResults saved to: ${outputFile}`);
  }
}

main().catch(e => {
  console.error(`\nFatal: ${e.message}`);
  process.exit(1);
});
