const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const {
  writeListCache, cacheFileForSlug, ensureListGuideXml, guideFileForSlug,
  lineupFileForSlug, withListLock,
} = require('../filters');
const { resolveEpgFile } = require('../epg');
const { escapeXml, publicBaseUrl } = require('../utils');
const { decryptString, timingSafeEqualStr } = require('../crypto');
const logger = require('../logger');

const router = express.Router();

function baseUrl(req) {
  return publicBaseUrl(req, config.publicBaseUrl);
}

function deviceId(slug) {
  return crypto.createHash('sha1').update(`meowarr:${slug}`).digest('hex').slice(0, 8).toUpperCase();
}

function deviceUUID(slug) {
  const h = crypto.createHash('sha1').update(`meowarr-uuid:${slug}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function getList(slug) {
  return db.prepare('SELECT * FROM lists WHERE slug = ?').get(slug);
}

function getCompiledChannels(listId) {
  return db.prepare(`
    SELECT c.* FROM compiled_channels c
    WHERE c.list_id = ?
      AND NOT EXISTS (SELECT 1 FROM broken_urls b WHERE b.url = c.url AND b.broken = 1)
    ORDER BY c.position
  `).all(listId);
}

async function ensureCompiled(list) {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM compiled_channels WHERE list_id = ?').get(list.id).c;
  if (existing > 0) return;
  await writeListCache(list.id);
}

function challenge(res, list) {
  res.setHeader('WWW-Authenticate', `Basic realm="meowarr:${list.slug}", charset="UTF-8"`);
  return res.status(401).type('text').send(res.locals.t ? res.locals.t('errors.authRequired') : 'Authentication required');
}

function listAuthMiddleware(req, res, next) {
  const list = getList(req.params.slug);
  if (!list) return res.status(404).type('text').send(res.locals.t ? res.locals.t('errors.listNotFound') : 'List not found');
  req.publicList = list;
  if (!list.basic_auth_user) return next();

  const header = req.headers.authorization || '';
  if (!header.toLowerCase().startsWith('basic ')) return challenge(res, list);

  let decoded;
  try { decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8'); } catch { return challenge(res, list); }
  const idx = decoded.indexOf(':');
  if (idx < 0) return challenge(res, list);

  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  let storedPass = '';
  try { storedPass = list.basic_auth_password ? decryptString(list.basic_auth_password) : ''; }
  catch (err) { logger.error({ err, slug: list.slug }, 'failed to decrypt list password'); return challenge(res, list); }
  const userOk = timingSafeEqualStr(user, list.basic_auth_user || '');
  const passOk = timingSafeEqualStr(pass, storedPass);
  if (!(userOk && passOk)) return challenge(res, list);
  next();
}

router.get('/lists/:slug/m3u8', listAuthMiddleware, async (req, res) => {
  const list = req.publicList;
  let file = cacheFileForSlug(list.slug);
  if (!fs.existsSync(file)) {
    const result = await writeListCache(list.id);
    if (!result) return res.status(404).type('text').send(res.locals.t('errors.listNotFound'));
    file = result.file;
  }
  const stat = fs.statSync(file);
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${list.slug}.m3u8"`);
  res.setHeader('Content-Length', stat.size);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  res.setHeader('X-Content-Type-Options', 'nosniff');
  fs.createReadStream(file).pipe(res);
});

router.get('/epg/:slug.xml', (req, res) => {
  const epg = db.prepare('SELECT * FROM epgs WHERE slug = ?').get(req.params.slug);
  if (!epg) return res.status(404).type('text').send(res.locals.t('errors.epgNotFound'));
  const file = resolveEpgFile(epg);
  if (!file) return res.status(404).type('text').send(res.locals.t('errors.epgNotSynced'));
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${epg.slug}.xml"`);
  res.sendFile(path.resolve(file));
});

function discoverPayload(req, list) {
  const base = `${baseUrl(req)}/lists/${list.slug}/hdhr`;
  return {
    FriendlyName: list.name,
    Manufacturer: 'meowarr',
    ManufacturerURL: 'https://github.com/altendorfme/meowarr/',
    ModelNumber: 'meowarr',
    FirmwareName: 'hdhomerun_atsc',
    FirmwareVersion: '20240101',
    DeviceID: deviceId(list.slug),
    DeviceAuth: 'meowarr',
    TunerCount: config.hdhrTunerCount,
    BaseURL: base,
    LineupURL: `${base}/lineup.json`,
  };
}

function sendDiscover(req, res) {
  res.json(discoverPayload(req, req.publicList));
}

router.get('/lists/:slug/hdhr', listAuthMiddleware, sendDiscover);
router.get('/lists/:slug/hdhr/discover.json', listAuthMiddleware, sendDiscover);

router.get('/lists/:slug/hdhr/lineup_status.json', listAuthMiddleware, (req, res) => {
  res.json({ ScanInProgress: 0, ScanPossible: 1, Source: 'Cable', SourceList: ['Cable'] });
});

router.post('/lists/:slug/hdhr/lineup.post', listAuthMiddleware, (req, res) => {
  res.json({ ok: true });
});

async function getOrBuildLineup(list) {
  const lineupFile = lineupFileForSlug(list.slug);
  const m3uFile = cacheFileForSlug(list.slug);
  let stale = !fs.existsSync(lineupFile);
  if (!stale && fs.existsSync(m3uFile)) {
    if (fs.statSync(m3uFile).mtimeMs > fs.statSync(lineupFile).mtimeMs) stale = true;
  }
  if (!stale) return JSON.parse(fs.readFileSync(lineupFile, 'utf8'));
  return withListLock(list.id, async () => {
    await ensureCompiled(list);
    const channels = getCompiledChannels(list.id);
    const lineup = channels.map((c, i) => ({
      GuideNumber: String(i + 1),
      GuideName: c.display_name || c.tvg_name || `Channel ${i + 1}`,
      URL: c.url,
      HD: 1,
    }));
    const tmp = `${lineupFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(lineup));
    fs.renameSync(tmp, lineupFile);
    return lineup;
  });
}

router.get('/lists/:slug/hdhr/lineup.json', listAuthMiddleware, async (req, res) => {
  try {
    const lineup = await getOrBuildLineup(req.publicList);
    res.json(lineup);
  } catch (err) {
    logger.error({ err, slug: req.publicList.slug }, 'lineup build failed');
    res.status(500).json({ error: 'lineup build failed' });
  }
});

router.get('/lists/:slug/hdhr/device.xml', listAuthMiddleware, (req, res) => {
  const list = req.publicList;
  const base = `${baseUrl(req)}/lists/${list.slug}/hdhr`;
  const friendly = list.name;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <URLBase>${base}</URLBase>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType>
    <friendlyName>${escapeXml(friendly)}</friendlyName>
    <manufacturer>meowarr</manufacturer>
    <modelName>meowarr</modelName>
    <modelNumber>meowarr</modelNumber>
    <serialNumber>${deviceId(list.slug)}</serialNumber>
    <UDN>uuid:${deviceUUID(list.slug)}</UDN>
  </device>
</root>
`;
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.send(xml);
});

router.get('/lists/:slug/guide.xml', listAuthMiddleware, async (req, res) => {
  const list = req.publicList;
  if (!list.epg_id) return res.status(404).type('text').send(res.locals.t('errors.listNoEpg'));
  const epg = db.prepare('SELECT * FROM epgs WHERE id = ?').get(list.epg_id);
  if (!epg) return res.status(404).type('text').send(res.locals.t('errors.epgNotFound'));
  if (!resolveEpgFile(epg)) return res.status(404).type('text').send(res.locals.t('errors.epgNotSynced'));

  await ensureCompiled(list);
  try {
    await ensureListGuideXml(list.id);
  } catch (err) {
    logger.error({ err, slug: list.slug }, 'guide xml build failed');
    return res.status(500).type('text').send('guide build failed');
  }
  const file = guideFileForSlug(list.slug);
  if (!fs.existsSync(file)) return res.status(404).type('text').send(res.locals.t('errors.epgNotSynced'));
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="${list.slug}.guide.xml"`);
  res.sendFile(path.resolve(file));
});

module.exports = router;
