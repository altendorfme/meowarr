const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const compression = require('compression');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./logger');
const db = require('./db');
const { requireAuth, renderLogin, handleLogin, handleLogout, loginLimiter } = require('./auth');
const i18n = require('./i18n');
const adminRoutes = require('./routes/admin');
const publicRoutes = require('./routes/public');
const cronRunner = require('./cron');
const assets = require('./assets');
const workerPool = require('./worker-pool');

const app = express();

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', /^\d+$/.test(String(config.trustProxy)) ? parseInt(config.trustProxy, 10) : config.trustProxy);
app.disable('x-powered-by');

app.use(pinoHttp({
  logger,
  customLogLevel(req, res, err) {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'debug';
  },
  serializers: {
    req: (r) => ({ method: r.method, url: r.url }),
    res: (r) => ({ status: r.statusCode }),
  },
}));

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'"],
      'img-src': ["'self'", 'data:', 'https:', 'http:'],
      'media-src': ["'self'", 'https:', 'http:', 'blob:'],
      'worker-src': ["'self'", 'blob:'],
      'child-src': ["'self'", 'blob:'],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'", 'https:', 'http:'],
      'frame-ancestors': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
      'upgrade-insecure-requests': null,
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

app.use(compression());
app.use(express.urlencoded({ extended: true, limit: '2mb', parameterLimit: 10000 }));
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

app.use(session({
  name: 'meowarr.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProduction ? 'auto' : false,
    maxAge: 1000 * 60 * 60 * 24 * 30,
  },
}));

app.use((req, res, next) => { res.locals.assets = assets; next(); });
app.use(i18n.middleware);
app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '7d', etag: true }));

app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1 AS ok').get();
    res.json({ ok: true, version: require('../package.json').version });
  } catch (err) {
    logger.error({ err }, 'healthz failed');
    res.status(500).json({ ok: false });
  }
});

function originCheck(req, res, next) {
  if (req.method !== 'POST') return next();
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && (fetchSite === 'same-origin' || fetchSite === 'none')) return next();
  const host = req.get('host');
  let origin = req.get('origin');
  if (origin === 'null' || origin === '') origin = null;
  const candidate = origin || req.get('referer');
  if (!candidate) return next();
  let parsed;
  try { parsed = new URL(candidate); }
  catch {
    logger.warn({ origin, referer: req.get('referer'), host, url: req.originalUrl }, 'origin check: unparseable header');
    return res.status(403).type('text').send('cross-origin POST rejected');
  }
  if (parsed.host !== host) {
    logger.warn({ originHost: parsed.host, host, url: req.originalUrl }, 'origin check: host mismatch');
    return res.status(403).type('text').send('cross-origin POST rejected');
  }
  next();
}

app.use(originCheck);

app.post('/lang', i18n.setLang);

app.use('/', publicRoutes);

app.get('/login', renderLogin);
app.post('/login', loginLimiter, handleLogin);
app.post('/logout', handleLogout);

app.use(requireAuth);
app.use('/', adminRoutes);

app.use((err, req, res, next) => {
  logger.error({ err, url: req.originalUrl }, 'request error');
  if (res.headersSent) return;
  res.status(500).send(res.locals.t ? res.locals.t('errors.internal') : 'Internal error');
});

if (!config.adminPassword) {
  logger.warn('ADMIN_PASSWORD not set - admin UI will be inaccessible until you set it in .env');
}

const server = app.listen(config.port, config.host, () => {
  logger.info({ host: config.host, port: config.port }, 'meowarr listening');
  cronRunner.start();
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown initiated');
  cronRunner.stop();
  server.close(async (err) => {
    if (err) logger.error({ err }, 'server close failed');
    try { await workerPool.shutdown(); } catch (_) { /* noop */ }
    try { db.close && db.close(); } catch (_) { /* noop */ }
    logger.info('shutdown complete');
    process.exit(err ? 1 : 0);
  });
  setTimeout(() => {
    logger.warn('forced exit after shutdown timeout');
    process.exit(1);
  }, 15000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
process.on('uncaughtException', (err) => { logger.fatal({ err }, 'uncaught exception'); shutdown('uncaughtException'); });
