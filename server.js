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
// LOGGING SETUP
// Access logs: morgan → console (dev) + logs/access.log (combined)
// Error logs:  logError() → console.error + logs/error.log
//
// CF Workers note: fs is unavailable in Workers. Use console.log
// (Cloudflare captures these) and configure CF Logpush for
// persistent storage. The file paths below are Node/Express only.
// ============================================================

const LOGS_DIR   = path.join(__dirname, 'logs');
const ACCESS_LOG = path.join(LOGS_DIR, 'access.log');
const ERROR_LOG  = path.join(LOGS_DIR, 'error.log');

// Ensure logs/ exists at startup
try {
  fs.mkdirSync(LOGS_DIR, { recursive: true });
} catch (err) {
  console.error('[STARTUP] Could not create logs/ directory:', err.message);
}

// File stream for access log (append mode, survives restarts)
const accessLogStream = fs.createWriteStream(ACCESS_LOG, { flags: 'a' });

/**
 * Write a structured line to logs/error.log and console.error.
 * Never throws — logging failure must not crash the server.
 *
 * @param {'ERROR'|'WARN'|'INFO'} level
 * @param {string}  message
 * @param {Error|null} err   - include .stack when available
 */
function logError(level, message, err = null) {
  const ts   = new Date().toISOString();
  const body = err ? `\n  ${err.stack ?? err.message ?? String(err)}` : '';
  const line = `[${ts}] [${level}] ${message}${body}`;

  console.error(line);

  try {
    fs.appendFileSync(ERROR_LOG, line + '\n');
  } catch (writeErr) {
    // Last-resort: if file write fails, at least console has it
    console.error('[LOG_WRITE_FAIL]', writeErr.message);
  }
}

// ============================================================
// LOAD STALLION DATABASE (once at startup)
// ============================================================

let STALLIONS = [];
try {
  const raw = fs.readFileSync(path.join(__dirname, 'data', 'stallions.json'), 'utf8');
  STALLIONS = JSON.parse(raw);
  console.log(`[DB] Loaded ${STALLIONS.length} stallions`);
} catch (err) {
  logError('ERROR', 'Failed to load stallions.json — server cannot start', err);
  process.exit(1);
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

// ============================================================
// MIDDLEWARE — ACCESS LOGGING (morgan)
//
// Two streams:
//   console  → 'dev' format (colored, concise — good for tailing in terminal)
//   file     → 'combined' format (Apache Combined Log Format — parseable by
//               log aggregators: Datadog, Papertrail, Logtail, etc.)
//
// Health check excluded from file log (noisy, adds no diagnostic value).
// ============================================================

// Skip health check from file log — uptime monitors poll constantly
const skipHealthCheck = (req) => req.path === '/api/health';

app.use(morgan('dev'));   // console — always on
app.use(morgan('combined', {
  stream: accessLogStream,
  skip:   skipHealthCheck,
}));

// ============================================================
// MIDDLEWARE — BODY PARSER (64kb max)
// ============================================================

app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// MIDDLEWARE — RATE LIMITER
// 10 req/min/IP on /api/analyze. CF Workers: use WAF rules instead.
// ============================================================

const analyzeLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    ipKeyGenerator,
  handler: (req, res) => {
    const ip = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
    logError('WARN', `Rate limit exceeded — IP: ${ip} PATH: ${req.path}`);
    res.status(429).json({
      error:               'RATE_LIMIT_EXCEEDED',
      message:             'Maximum 10 requests per minute per IP.',
      retry_after_seconds: 60,
    });
  },
});

const readLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             60,
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    ipKeyGenerator,
});

// ============================================================
// MIDDLEWARE — API KEY AUTH
// BREEDING_API_KEY not set → open (dev mode).
// BREEDING_API_KEY set     → X-Api-Key header required.
// CF Workers: store key in CF Secret, use CF Access for UX auth.
// ============================================================

function requireApiKey(req, res, next) {
  const expected = process.env.BREEDING_API_KEY;
  if (!expected) return next();

  const provided = req.headers['x-api-key'];
  if (!provided) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'X-Api-Key header required.' });
  }
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
    if (isNaN(n))               errors.push(`${section}.${field}: must be a number, got "${val}"`);
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
  if (errors.length) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Input validation failed.', errors });
  }

  const t0 = Date.now();
  try {
    const { output, diagnostics } = runPipeline(STALLIONS, req.body);
    const ms = Date.now() - t0;

    // Log pipeline timing for performance monitoring
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

// Health check: no auth, no rate limit, excluded from file access log
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', stallions: STALLIONS.length, uptime: Math.round(process.uptime()), version: '1.0.0' });
});

// ============================================================
// GLOBAL ERROR HANDLER
// ============================================================

app.use((err, req, res, _next) => {
  logError('ERROR', `Unhandled middleware error on ${req.method} ${req.path}`, err);
  res.status(500).json({ error: 'SERVER_ERROR', message: 'Unexpected server error.' });
});

// ============================================================
// PROCESS-LEVEL ERROR CAPTURE
// Catches unhandled promise rejections and uncaught exceptions.
// Logs them before the process exits (or continues, for rejections).
// ============================================================

process.on('uncaughtException', (err) => {
  logError('ERROR', 'Uncaught exception — server will exit', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logError('WARN', 'Unhandled promise rejection', reason instanceof Error ? reason : new Error(String(reason)));
  // Do not exit — rejections are recoverable
});

// ============================================================
// START
// ============================================================

app.listen(PORT, () => {
  const keyStatus = process.env.BREEDING_API_KEY ? 'API key required' : 'OPEN (no BREEDING_API_KEY set)';
  console.log(`[Server] Breeding Engine → http://localhost:${PORT}`);
  console.log(`[Auth]   ${keyStatus}`);
  console.log(`[Rate]   10 req/min/IP on /api/analyze`);
  console.log(`[Logs]   ${ACCESS_LOG}`);
  console.log(`[Errors] ${ERROR_LOG}`);
});
