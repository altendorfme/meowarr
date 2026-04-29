const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const SUPPORTED = ['pt-BR', 'en'];
const LANG_NAMES = { 'pt-BR': 'Português', 'en': 'English' };
const DEFAULT_LANG = 'pt-BR';
const COOKIE_NAME = 'lang';
const COOKIE_MAX_AGE = 1000 * 60 * 60 * 24 * 365;

const translations = {};
for (const lang of SUPPORTED) {
  const file = path.join(__dirname, 'locales', `${lang}.json`);
  translations[lang] = JSON.parse(fs.readFileSync(file, 'utf8'));
}

function flattenKeys(obj, prefix = '') {
  const keys = new Set();
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const sub of flattenKeys(v, full)) keys.add(sub);
    } else {
      keys.add(full);
    }
  }
  return keys;
}

(function checkParity() {
  const ref = flattenKeys(translations[DEFAULT_LANG]);
  for (const lang of SUPPORTED) {
    if (lang === DEFAULT_LANG) continue;
    const cur = flattenKeys(translations[lang]);
    const missing = [...ref].filter(k => !cur.has(k));
    const extra = [...cur].filter(k => !ref.has(k));
    if (missing.length || extra.length) {
      logger.warn({ lang, missing, extra }, 'locale parity drift');
    }
  }
})();

function get(obj, keyPath) {
  return keyPath.split('.').reduce((o, k) => (o && o[k] != null) ? o[k] : null, obj);
}

function interpolate(str, params) {
  if (typeof str !== 'string' || !params) return str;
  return str.replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? String(params[k]) : `{${k}}`));
}

function detectLang(req) {
  const cookieLang = req.cookies && req.cookies[COOKIE_NAME];
  if (cookieLang && SUPPORTED.includes(cookieLang)) return cookieLang;
  const al = String(req.headers['accept-language'] || '').toLowerCase();
  if (al.startsWith('en')) return 'en';
  if (al.startsWith('pt')) return 'pt-BR';
  return DEFAULT_LANG;
}

function makeT(lang) {
  const dict = translations[lang] || translations[DEFAULT_LANG];
  const fallback = translations[DEFAULT_LANG];
  return (key, params) => {
    const val = get(dict, key);
    const out = (val != null) ? val : (get(fallback, key) ?? key);
    return interpolate(out, params);
  };
}

function middleware(req, res, next) {
  const lang = detectLang(req);
  res.locals.lang = lang;
  res.locals.langs = SUPPORTED;
  res.locals.langNames = LANG_NAMES;
  res.locals.t = makeT(lang);
  next();
}

function setLang(req, res) {
  const lang = (req.body && req.body.lang) || (req.query && req.query.lang);
  if (SUPPORTED.includes(lang)) {
    res.cookie(COOKIE_NAME, lang, { httpOnly: false, sameSite: 'lax', maxAge: COOKIE_MAX_AGE });
  }
  const back = (req.body && req.body.back) || req.headers.referer || '/';
  res.redirect(back);
}

module.exports = { middleware, setLang, makeT, SUPPORTED, LANG_NAMES, DEFAULT_LANG, translations };
