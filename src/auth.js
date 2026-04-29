const rateLimit = require('express-rate-limit');
const config = require('./config');
const { timingSafeEqualStr } = require('./crypto');

function isSafeReturnPath(p) {
  return typeof p === 'string'
    && p.startsWith('/')
    && !p.startsWith('//')
    && !p.startsWith('/\\')
    && p !== '/login'
    && !p.startsWith('/login?');
}

function refererPath(req) {
  const ref = req.get && req.get('referer');
  if (!ref) return null;
  try {
    const host = req.get('host');
    const u = new URL(ref);
    if (host && u.host !== host) return null;
    return u.pathname + u.search;
  } catch {
    return null;
  }
}

function pickReturnTo(req) {
  const candidates = [
    req.body && req.body.returnTo,
    req.query && req.query.next,
    req.session && req.session.returnTo,
    refererPath(req),
  ];
  for (const c of candidates) {
    if (isSafeReturnPath(c)) return c;
  }
  return null;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  if (req.method === 'GET' && req.accepts('html') && isSafeReturnPath(req.originalUrl)) {
    req.session.returnTo = req.originalUrl;
  }
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ error: res.locals.t ? res.locals.t('errors.unauthorized') : 'unauthorized' });
}

function renderLogin(req, res) {
  const returnTo = pickReturnTo(req);
  if (req.session && req.session.authed) {
    return res.redirect(returnTo || '/');
  }
  if (returnTo) req.session.returnTo = returnTo;
  res.render('login', { error: null, returnTo: returnTo || '' });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: config.rateLimitLogin,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: 'Too many login attempts, please try again later.',
});

function handleLogin(req, res) {
  const password = (req.body && req.body.password) || '';
  const returnTo = pickReturnTo(req);
  if (!config.adminPassword) {
    return res.status(500).render('login', { error: res.locals.t('login.notConfigured'), returnTo: returnTo || '' });
  }
  if (!timingSafeEqualStr(password, config.adminPassword)) {
    return res.status(401).render('login', { error: res.locals.t('login.wrongPassword'), returnTo: returnTo || '' });
  }
  req.session.regenerate((err) => {
    if (err) return res.status(500).render('login', { error: res.locals.t('errors.internal'), returnTo: returnTo || '' });
    req.session.authed = true;
    req.session.save((err2) => {
      if (err2) return res.status(500).render('login', { error: res.locals.t('errors.internal'), returnTo: returnTo || '' });
      return res.redirect(returnTo || '/');
    });
  });
}

function handleLogout(req, res) {
  const fromBody = req.body && req.body.returnTo;
  const fromReferer = refererPath(req);
  const returnTo = isSafeReturnPath(fromBody) ? fromBody
    : (isSafeReturnPath(fromReferer) ? fromReferer : null);
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    const target = returnTo ? `/login?next=${encodeURIComponent(returnTo)}` : '/login';
    res.redirect(target);
  });
}

module.exports = { requireAuth, renderLogin, handleLogin, handleLogout, loginLimiter };
