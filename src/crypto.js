const crypto = require('crypto');
const config = require('./config');

const ALGO = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

function encryptString(plain) {
  if (plain == null || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, config.encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decryptString(stored) {
  if (stored == null || stored === '') return '';
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return String(stored);
  const buf = Buffer.from(stored.slice(PREFIX.length), 'base64');
  if (buf.length < 28) return '';
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, config.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { encryptString, decryptString, timingSafeEqualStr };
