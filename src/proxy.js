const dns = require('dns').promises;
const net = require('net');
const { Readable } = require('stream');
const config = require('./config');
const logger = require('./logger');

const PROXY_FORWARD_REQ_HEADERS = ['accept', 'accept-language', 'range', 'if-modified-since', 'if-none-match'];
const PROXY_FORWARD_RES_HEADERS = ['content-type', 'cache-control', 'last-modified', 'etag', 'accept-ranges', 'content-length', 'content-range', 'expires'];
const PROXY_TOTAL_TIMEOUT_MS = parseInt(process.env.PROXY_TOTAL_TIMEOUT_MS || '60000', 10);
const PROXY_HEADER_TIMEOUT_MS = parseInt(process.env.PROXY_HEADER_TIMEOUT_MS || '30000', 10);
const PROXY_USER_AGENT = process.env.PROXY_USER_AGENT || 'VLC/3.0.20 LibVLC/3.0.20';

function isPrivateIPv4(ip) {
  if (!ip) return false;
  const parts = ip.split('.').map(n => parseInt(n, 10));
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p))) return false;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIPv6(ip) {
  if (!ip) return false;
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (net.isIPv4(v4)) return isPrivateIPv4(v4);
  }
  return false;
}

function isPrivateAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

async function assertPublicUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('invalid url'); }
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error('protocol not allowed');
  if (config.proxyAllowPrivate) return parsed;
  const host = parsed.hostname;
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('blocked private address');
    return parsed;
  }
  const records = await dns.lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (!records.length) throw new Error('dns lookup failed');
  for (const rec of records) {
    if (isPrivateAddress(rec.address)) throw new Error(`blocked private address: ${rec.address}`);
  }
  return parsed;
}

function proxyifyUrl(u) {
  return '/proxy/stream?url=' + encodeURIComponent(u);
}

function rewriteM3U8(text, baseUrl) {
  const abs = (u) => { try { return new URL(u, baseUrl).toString(); } catch { return u; } };
  return text.split(/\r?\n/).map(line => {
    if (!line) return line;
    if (line.charCodeAt(0) === 35) {
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxyifyUrl(abs(u))}"`);
    }
    return proxyifyUrl(abs(line));
  }).join('\n');
}

async function proxyCheck(req, res) {
  const url = String(req.query.url || '').trim();
  let parsed;
  try { parsed = await assertPublicUrl(url); }
  catch (err) { return res.status(400).json({ error: err.message }); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) { /* noop */ } }, 6000);
  try {
    const resp = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'manual',
      signal: ctrl.signal,
      headers: { 'user-agent': PROXY_USER_AGENT },
    });
    try { resp.body && await resp.body.cancel(); } catch (_) { /* noop */ }
    res.json({ broken: !resp.ok, status: resp.status });
  } catch (err) {
    logger.debug({ err: err && err.message, url }, 'proxy check fetch failed');
    res.json({ broken: true, error: err && err.message });
  } finally {
    clearTimeout(timer);
  }
}

async function proxyStream(req, res) {
  const url = String(req.query.url || '').trim();
  let parsed;
  try { parsed = await assertPublicUrl(url); }
  catch (err) { return res.status(400).type('text').send(err.message); }

  const headers = { 'user-agent': PROXY_USER_AGENT };
  for (const h of PROXY_FORWARD_REQ_HEADERS) {
    const v = req.headers[h];
    if (v) headers[h] = Array.isArray(v) ? v.join(', ') : v;
  }
  if (req.headers['x-proxy-user-agent']) headers['user-agent'] = String(req.headers['x-proxy-user-agent']);

  const ctrl = new AbortController();
  const totalTimer = setTimeout(() => { try { ctrl.abort(); } catch (_) { /* noop */ } }, PROXY_TOTAL_TIMEOUT_MS);
  const headerTimer = setTimeout(() => { try { ctrl.abort(); } catch (_) { /* noop */ } }, PROXY_HEADER_TIMEOUT_MS);
  const onClose = () => {
    try { ctrl.abort(); } catch (_) { /* noop */ }
    clearTimeout(totalTimer);
    clearTimeout(headerTimer);
  };
  req.on('close', onClose);

  let resp;
  try {
    resp = await fetch(parsed.toString(), { method: 'GET', headers, redirect: 'manual', signal: ctrl.signal });
  } catch (err) {
    clearTimeout(headerTimer);
    clearTimeout(totalTimer);
    logger.warn({ err: err && err.message, code: err && err.code, cause: err && err.cause && err.cause.code, url: parsed.toString() }, 'proxy stream fetch failed');
    if (!res.headersSent) res.status(502).type('text').send('proxy fetch failed: ' + (err && err.message ? err.message : 'unknown'));
    return;
  }
  clearTimeout(headerTimer);

  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get('location');
    try { resp.body && await resp.body.cancel(); } catch (_) { /* noop */ }
    clearTimeout(totalTimer);
    if (!loc) {
      if (!res.headersSent) res.status(502).type('text').send('upstream redirect missing location');
      return;
    }
    let next;
    try { next = new URL(loc, parsed.toString()).toString(); }
    catch { if (!res.headersSent) res.status(502).type('text').send('upstream redirect invalid'); return; }
    return res.redirect(302, '/proxy/stream?url=' + encodeURIComponent(next));
  }

  res.status(resp.status);
  for (const h of PROXY_FORWARD_RES_HEADERS) {
    const v = resp.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  res.setHeader('Access-Control-Allow-Origin', '*');

  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  const lower = parsed.pathname.toLowerCase();
  const isPlaylist = ct.includes('mpegurl') || ct.includes('x-mpegurl') || lower.endsWith('.m3u8') || lower.endsWith('.m3u');

  if (isPlaylist) {
    try {
      const text = await resp.text();
      const baseUrl = parsed.toString();
      const out = rewriteM3U8(text, baseUrl);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.removeHeader('Content-Length');
      res.removeHeader('Content-Range');
      res.send(out);
    } catch (err) {
      if (!res.headersSent) res.status(502).type('text').send('proxy read failed');
    } finally {
      clearTimeout(totalTimer);
    }
    return;
  }

  if (!resp.body) {
    clearTimeout(totalTimer);
    return res.end();
  }
  try {
    const r = Readable.fromWeb(resp.body);
    r.on('error', () => { try { res.end(); } catch (_) { /* noop */ } });
    r.on('close', () => clearTimeout(totalTimer));
    r.pipe(res);
  } catch (err) {
    clearTimeout(totalTimer);
    if (!res.headersSent) res.status(502).type('text').send('proxy stream failed');
  }
}

module.exports = { proxyCheck, proxyStream };
