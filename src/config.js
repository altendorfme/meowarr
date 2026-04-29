require('dotenv').config();
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

const sessionSecret = process.env.SESSION_SECRET || '';
const adminPassword = process.env.ADMIN_PASSWORD || '';

if (!sessionSecret || sessionSecret.length < 32) {
  console.error('[FATAL] SESSION_SECRET is required and must be at least 32 characters.');
  process.exit(1);
}
if (sessionSecret === 'change-me' || sessionSecret === 'jwt') {
  console.error('[FATAL] SESSION_SECRET must not be a default placeholder.');
  process.exit(1);
}

const encryptionKey = crypto.scryptSync(sessionSecret, 'meowarr-enc-v1', 32);

module.exports = {
  port: parseInt(process.env.PORT || '9797', 10),
  host: process.env.HOST || '0.0.0.0',
  adminPassword,
  sessionSecret,
  encryptionKey,
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, ''),
  cronDaily: process.env.CRON_DAILY || '0 4 * * *',
  cronCleanup: process.env.CRON_CLEANUP || '30 4 * * *',
  dataDir: DATA_DIR,
  dbPath: path.join(DATA_DIR, 'meowarr.db'),
  reposDir: path.join(DATA_DIR, 'repos'),
  epgCacheDir: path.join(DATA_DIR, 'epg'),
  listsCacheDir: path.join(DATA_DIR, 'lists'),
  hdhrTunerCount: parseInt(process.env.HDHR_TUNER_COUNT || '4', 10),
  trustProxy: process.env.TRUST_PROXY || '0',
  proxyAllowPrivate: process.env.PROXY_ALLOW_PRIVATE === '1',
  rateLimitLogin: parseInt(process.env.RATE_LIMIT_LOGIN || '10', 10),
  isProduction: process.env.NODE_ENV === 'production',
  logLevel: process.env.LOG_LEVEL || 'info',
};
