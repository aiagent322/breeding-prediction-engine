'use strict';

const express   = require('express');
const path      = require('path');
const fs        = require('fs');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;

const { runPipeline } = require('./engine/pipeline');

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// SUPABASE CONFIG
// Set SUPABASE_URL and SUPABASE_SERVICE_KEY in your environment.
// Falls back to local stallions.json if env vars are missing (dev mode).
// ============================================================

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// ============================================================
// LOGGING SETUP
// ============================================================

const LOGS_DIR   = path.join(__dirname, 'logs');
const ACCESS_LOG = path.join(LOGS_DIR, 'access.log');
const ERROR_LOG  = path.join(LOGS_DIR, 'error.log');

try {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch (err) {
  console.error('[STARTUP] Could not create logs/ directory:', err.message);
}

const accessLogStream = fs.createWriteStream(ACCESS_LOG, { flags: 'a' });

function logError(level, message, err = null) {
  const ts   = new Date().toISOString();
  const body = err ? `\n  ${err.stack ?? err.message ?? String(err)}` : '';
  const line = `[${ts}] [${level}] ${message}${body}`;
  console.error(line);
  try {
    fs.appendFileSync(ERROR_LOG, line + '\n');
  } catch (writeErr) {
    console.error('[LOG_WRITE_FAIL]', writeErr.message);
  }
}

// ============================================================
// LOAD STALLION DATABASE
// Supabase is the source of truth. Local JSON is the fallback.
// Normalises Supabase snake_case keys back to the camelCase shape
// that pipeline.js expects (e.g. disc_earnings_cowhorse → cowHorse).
// ============================================================

// Remap Supabase snake_case → pipeline camelCase where needed
function normaliseRow(row) {
  return {
    ...row,
    // financials
    earnings_total_usd:           row.lifetime_earnings_usd,
    offspring_earnings_total_usd: row.offspring_earnings_total_usd,
    // discipline earnings
    disc_earnings_cowHorse:    row.disc_earnings_cowhorse,
    disc_earnings_teamRoping:  row.disc_earnings_teamroping,
    disc_earnings_barrelRacing: row.disc_earnings_barrelracing,
    disc_earnings_ranchRiding:  row.disc_earnings_ranchriding,
    // discipline strengths
    disc_strength_cowHorse:    row.disc_strength_cowhorse,
    disc_strength_teamRoping:  row.disc_strength_teamroping,
    disc_strength_barrelRacing: row.disc_strength_barrelracing,
    disc_strength_ranchRiding:  row.disc_strength_ranchriding,
  };
}

async function loadFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/stallions?select=*&limit=500`;
  const res  = await fetch(url, {
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Supabase HTTP ${res.status}: ${await res.text()}`);
  const rows = await res.json();
  return rows.map(normaliseRow);
}

function loadFromJson() {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'stallions.json'), 'utf8');
  return JSON.parse(raw);
}

let STALLIONS = [];

async function initDB() {
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      STALLIONS = await loadFromSupabase();
      console.log(`[DB] Loaded ${STALLIONS.length} stallions from Supabase`);
      return;
    } catch (err) {
      logError('WARN', 'Supabase load failed — falling back to stallions.json', err);
    }
  } else {
    console.log('[DB] No SUPABASE_URL/KEY set — using local stallions.json');
  }
  try {
    STALLIONS = loadFromJson();
    console.log(`[DB] Loaded ${STALLIONS.length} stallions from stallions.json`);
  } catch (err) {
    logError('ERROR', 'Failed to load stallions.json — server cannot start', err);
    process.exit(1);
  }
}

// ============================================================
// MIDDLEWARE — SECURITY HEADERS
// ============================================================

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  const origin = process.env.ALLOWED_ORIGIN;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const skipHealthCheck = (req) => req.path === '/api/health';
app.use(morgan('dev'));
app.use(morgan('combined', { stream: accessLogStream, skip: skipHealthCheck }));

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// MIDDLEWARE — RATE LIMITERS
// ============================================================

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
  handler: (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    logError('WARN', `Rate limit exceeded — IP: ${ip} PATH: ${req.path}`);
    res.status(429).json({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Maximum 10 requests per minute per IP.',
      retry_after_seconds: 60,
    });
  },
});

const readLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60,
  standardHeaders: true, legacyHeaders: false,
  keyGenerator: ipKeyGenerator,
});

// ============================================================
// MIDDLEWARE — API KEY AUTH
// ============================================================

function requireApiKey(req, res, next) {
  const expected = process.env.BREEDING_API_KEY;
  if (!expected) return next();
  const provided = req.headers['x-api-key'];
  if (!provided)
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'X-Api-Key header required.' });
  if (provided !== expected) {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    logError('WARN', `Auth failure — invalid API key from ${ip}`);
    return res.status(403).json({ error: 'FORBIDDEN', message: 'Invalid API key.' });
  }
  next();
}

// ============================================================
// INPUT VALIDATION
// ============================================================

const VALID = {
  disciplines:  ['reining','cutting','cowHorse','teamRoping','barrelRacing','ranchRiding'],
  reactivity:   ['low','moderate','high'],
  weight_class: ['light','medium','heavy'],
  earnings:     ['none','regional','listed','stakes','elite'],
  perf_levels:  ['green','amateur','regional','open','elite'],
  budget:       ['under2k','under5k','any'],
  availability: ['open','limited'],
  weakness:     ['cowSense','speedRating','stamina','trainability','temperament'],
  eye_types:    ['standard','blue','partial_blue','glass'],
};

const NUMERIC_RANGES = [
  ['genetics', 'dam_strength_score', 0,    100  ],
  ['physical', 'height_hands',       13.0, 17.3 ],
  ['physical', 'bone_density_score', 0,    100  ],
  ['physical', 'balance_score',      0,    100  ],
  ['mental',   'trainability',       0,    100  ],
  ['mental',   'consistency',        0,    100  ],
  ['health',   'soundness_score',    0,    100  ],
];

const ENUM_FIELDS = [
  ['performance', 'discipline',  VALID.disciplines ],
  ['performance', 'earnings',    VALID.earnings    ],
  ['performance', 'level',       VALID.perf_levels ],
  ['mental',      'reactivity',  VALID.reactivity  ],
  ['physical',    'weight_class',VALID.weight_class],
  ['cosmetic',    'eye_type',    VALID.eye_types   ],
  ['preferences', 'budget',      VALID.budget      ],
  ['preferences', 'availability',VALID.availability],
  ['preferences', 'weakness',    VALID.weakness    ],
];

function validateMareInput(mare) {
  const errors = [];
  if (!mare || typeof mare !== 'object') return ['Request body must be a JSON object'];
  if (!mare?.performance?.discipline)
    errors.push('performance.discipline: required field is missing');
  for (const [section, field, min, max] of NUMERIC_RANGES) {
    const val = mare?.[section]?.[field];
    if (val == null) continue;
    const n = Number(val);
    if (isNaN(n))                errors.push(`${section}.${field}: must be a number, got "${val}"`);
    else if (n < min || n > max) errors.push(`${section}.${field}: ${n} out of range [${min}–${max}]`);
  }
  for (const [section, field, allowed] of ENUM_FIELDS) {
    const val = mare?.[section]?.[field];
    if (val == null || val === '') continue;
    if (!allowed.includes(val))
      errors.push(`${section}.${field}: "${val}" not valid — must be one of: ${allowed.join(', ')}`);
  }
  return errors;
}

// ============================================================
// ROUTES
// ============================================================

app.post('/api/analyze', requireApiKey, analyzeLimiter, (req, res) => {
  const errors = validateMareInput(req.body);
  if (errors.length)
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Input validation failed.', errors });

  const t0 = Date.now();
  try {
    const { output, diagnostics } = runPipeline(STALLIONS, req.body);
    const ms = Date.now() - t0;
    console.log(`[PIPELINE] ${req.body?.performance?.discipline} ${diagnostics.afterHardFilter}→${diagnostics.tiersSelected} tiers in ${ms}ms`);
    if (!output.matches.length) {
      return res.status(200).json({
        matches: [], confidence: 0,
        message: 'No stallions matched the discipline and compatibility criteria.', diagnostics,
      });
    }
    return res.status(200).json({ ...output, diagnostics });
  } catch (err) {
    logError('ERROR', `Pipeline failure for discipline "${req.body?.performance?.discipline}"`, err);
    return res.status(500).json({ error: 'PIPELINE_ERROR', message: 'Internal scoring error.' });
  }
});

app.get('/api/stallions', requireApiKey, readLimiter, (req, res) => {
  const { discipline } = req.query;
  const data = discipline ? STALLIONS.filter(s => s._disciplines?.includes(discipline)) : STALLIONS;
  res.json({ count: data.length, stallions: data });
});

app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    stallions: STALLIONS.length,
    source:    (SUPABASE_URL && SUPABASE_KEY) ? 'supabase' : 'local-json',
    uptime:    Math.round(process.uptime()),
    version:   '1.1.0',
  });
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((err, req, res, _next) => {
  logError('ERROR', `Unhandled middleware error on ${req.method} ${req.path}`, err);
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Unexpected server error.' });
});

process.on('uncaughtException', (err) => {
  logError('ERROR', 'Uncaught exception — server will exit', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logError('WARN', 'Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
});

// ============================================================
// START — init DB then listen
// ============================================================

initDB().then(() => {
  const keyStatus = process.env.BREEDING_API_KEY ? 'API key required' : 'OPEN (no BREEDING_API_KEY set)';
  app.listen(PORT, () => {
    console.log(`[Server] Breeding Engine → http://localhost:${PORT}`);
    console.log(`[Auth]   ${keyStatus}`);
    console.log(`[DB]     ${(SUPABASE_URL && SUPABASE_KEY) ? 'Supabase: ' + SUPABASE_URL : 'Local stallions.json'}`);
    console.log(`[Rate]   10 req/min/IP on /api/analyze`);
    console.log(`[Logs]   ${ACCESS_LOG}`);
    console.log(`[Errors] ${ERROR_LOG}`);
  });
});
