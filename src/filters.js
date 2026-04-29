const fs = require('fs');
const path = require('path');
const sax = require('sax');
const db = require('./db');
const config = require('./config');
const { streamM3UToFile } = require('./m3u8parser');
const { loadLookupData, resolveEpgFile } = require('./epg');
const { escapeXml } = require('./utils');
const constants = require('./constants');
const logger = require('./logger');
const workerPool = require('./worker-pool');

const PERSIST_CHUNK = parseInt(process.env.REGEN_PERSIST_CHUNK || '2000', 10);
const tick = () => new Promise(setImmediate);

function checkAbort(signal) {
  if (signal && signal.aborted) {
    const err = new Error('aborted');
    err.aborted = true;
    throw err;
  }
}

const buildLocks = new Map();
async function withListLock(listId, fn) {
  const prev = buildLocks.get(listId) || Promise.resolve();
  let release;
  const next = new Promise(r => { release = r; });
  buildLocks.set(listId, prev.then(() => next));
  await prev;
  try { return await fn(); }
  finally {
    release();
    if (buildLocks.get(listId) === prev.then(() => next)) buildLocks.delete(listId);
  }
}

const stmts = {
  loadList: () => db.prepare('SELECT * FROM lists WHERE id = ?'),
  loadGroups: () => db.prepare('SELECT * FROM list_groups WHERE list_id = ? ORDER BY position, id'),
  loadGroupRules: () => db.prepare('SELECT * FROM list_rules WHERE group_id = ? ORDER BY position, id'),
  loadLinkedSources: () => db.prepare('SELECT source_id FROM list_sources WHERE list_id = ?'),
  loadReplacements: () => db.prepare('SELECT id, field, find, replace, is_regex, position FROM list_replacements WHERE list_id = ? ORDER BY position, id'),
  brokenImages: () => db.prepare('SELECT url FROM broken_images WHERE broken = 1'),
  brokenUrls: () => db.prepare('SELECT url FROM broken_urls WHERE broken = 1'),
  imgOverrides: () => db.prepare(`
    SELECT i.id, i.target_url, i.source_url, r.field, r.operator, r.value, r.position
    FROM image_overrides i
    LEFT JOIN image_override_rules r ON r.image_id = i.id
    WHERE i.enabled = 1
    ORDER BY i.id, r.position, r.id
  `),
  loadAllChannels: () => db.prepare('SELECT * FROM channels'),
  delCompiled: () => db.prepare('DELETE FROM compiled_channels WHERE list_id = ?'),
  insCompiled: () => db.prepare(`INSERT INTO compiled_channels
    (list_id, position, tvg_id, tvg_name, tvg_logo, group_title, display_name, url, extra_lines, duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  loadCompiled: () => db.prepare('SELECT * FROM compiled_channels WHERE list_id = ? ORDER BY position'),
  loadCompiledBasic: () => db.prepare(`SELECT position, tvg_id, tvg_name, tvg_logo, display_name
    FROM compiled_channels WHERE list_id = ? ORDER BY position`),
};
const _cache = {};
function S(name) { return _cache[name] || (_cache[name] = stmts[name]()); }

function loadBrokenImageSet() { return new Set(S('brokenImages').all().map(r => r.url)); }
function loadBrokenUrlSet() { return new Set(S('brokenUrls').all().map(r => r.url)); }

function loadImageOverrides(brokenSet) {
  const rows = S('imgOverrides').all();
  const byId = new Map();
  for (const row of rows) {
    if (brokenSet && brokenSet.has(row.target_url)) continue;
    if (!byId.has(row.id)) {
      byId.set(row.id, { id: row.id, target_url: row.target_url, source_url: row.source_url, rules: [] });
    }
    if (row.field) byId.get(row.id).rules.push({ field: row.field, operator: row.operator, value: row.value });
  }
  return Array.from(byId.values());
}

function loadListConfig(listId) {
  const list = S('loadList').get(listId);
  if (!list) return null;
  const groups = S('loadGroups').all(listId);
  const rulesStmt = S('loadGroupRules');
  const groupsWithRules = groups.map(g => ({ ...g, rules: rulesStmt.all(g.id) }));
  const linkedSourceIds = S('loadLinkedSources').all(listId).map(r => r.source_id);
  const replacements = S('loadReplacements').all(listId);
  return { list, groups: groupsWithRules, linkedSourceIds, replacements };
}

async function resolveListChannels(listId, onProgress, signal) {
  const cfg = loadListConfig(listId);
  if (!cfg) return null;
  const { list, groups, linkedSourceIds, replacements } = cfg;

  let raw;
  if (linkedSourceIds.length === 0) {
    raw = S('loadAllChannels').all();
  } else {
    const placeholders = linkedSourceIds.map(() => '?').join(',');
    raw = db.prepare(`SELECT * FROM channels WHERE source_id IN (${placeholders})`).all(...linkedSourceIds);
  }
  checkAbort(signal);

  const epgData = list.epg_id ? loadLookupData(list.epg_id) : null;
  const normOpts = {
    caseMode: list.norm_case || 'none',
    stripSpecials: !!list.norm_strip_specials,
  };
  const brokenSet = loadBrokenImageSet();
  const imageOverrides = loadImageOverrides(brokenSet);
  const brokenList = brokenSet.size ? Array.from(brokenSet) : [];

  const channels = await workerPool.runResolve(
    { raw, groups, replacements, normOpts, epgData, imageOverrides, brokenList },
    (done, total) => { if (onProgress) onProgress(done, total); },
    signal
  );
  return { list, channels };
}

async function buildListResolution(listId, onProgress, signal) {
  const r = await resolveListChannels(listId, onProgress, signal);
  if (!r) return null;
  checkAbort(signal);
  const brokenUrls = loadBrokenUrlSet();
  const live = brokenUrls.size ? r.channels.filter(c => !brokenUrls.has(c.url)) : r.channels;
  return { list: r.list, live, count: live.length, channels: r.channels };
}

async function rewriteListM3UFromCompiled(listId, onProgress) {
  const list = S('loadList').get(listId);
  if (!list) return null;
  const all = S('loadCompiled').all(listId);
  const brokenUrls = loadBrokenUrlSet();
  const live = brokenUrls.size ? all.filter(c => !brokenUrls.has(c.url)) : all;
  const file = cacheFileForSlug(list.slug);
  await streamM3UToFile(live, file, { onChunk: async (done, total) => {
    if (onProgress) onProgress(done, total);
    await tick();
  } });
  removeListLineupCache(list.slug);
  return { file, count: live.length, slug: list.slug };
}

async function rewriteAllListM3UFromCompiled() {
  const lists = db.prepare('SELECT id FROM lists').all();
  for (const l of lists) {
    try { await rewriteListM3UFromCompiled(l.id); }
    catch (err) { logger.error({ err, listId: l.id }, 'rewrite m3u failed'); }
    await tick();
  }
}

function cacheFileForSlug(slug) { return path.join(config.listsCacheDir, `${slug}.m3u8`); }
function guideFileForSlug(slug) { return path.join(config.listsCacheDir, `${slug}.guide.xml`); }
function lineupFileForSlug(slug) { return path.join(config.listsCacheDir, `${slug}.lineup.json`); }

function buildListGuideXml(listId) {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
  if (!list || !list.epg_id) return Promise.resolve(null);
  const epg = db.prepare('SELECT * FROM epgs WHERE id = ?').get(list.epg_id);
  const epgFile = resolveEpgFile(epg);
  if (!epgFile) return Promise.resolve(null);

  const channels = S('loadCompiledBasic').all(listId);
  if (channels.length === 0) return Promise.resolve(null);

  const tvgIdToGuides = new Map();
  channels.forEach((c, i) => {
    if (!c.tvg_id) return;
    const guide = String(i + 1);
    if (!tvgIdToGuides.has(c.tvg_id)) tvgIdToGuides.set(c.tvg_id, []);
    tvgIdToGuides.get(c.tvg_id).push(guide);
  });

  const outFile = guideFileForSlug(list.slug);
  const tmp = `${outFile}.tmp`;
  const stream = fs.createWriteStream(tmp, { encoding: 'utf8' });
  stream.write(`<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="meowarr">\n`);
  for (let i = 0; i < channels.length; i++) {
    const c = channels[i];
    const guide = String(i + 1);
    const name = c.display_name || c.tvg_name || c.tvg_id || `Channel ${guide}`;
    stream.write(`  <channel id="${guide}">\n    <display-name>${escapeXml(name)}</display-name>\n`);
    if (c.tvg_logo) stream.write(`    <icon src="${escapeXml(c.tvg_logo)}"/>\n`);
    stream.write(`  </channel>\n`);
  }

  if (tvgIdToGuides.size === 0) {
    stream.write('</tv>\n');
    return new Promise((resolve, reject) => {
      stream.on('finish', () => { fs.renameSync(tmp, outFile); resolve({ file: outFile, count: channels.length }); });
      stream.on('error', reject);
      stream.end();
    });
  }

  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: false });
    const src = fs.createReadStream(epgFile, { encoding: 'utf8' });
    let inProgramme = false;
    let progAttrs = null;
    let progBody = '';
    let progDepth = 0;
    let serializing = '';

    parser.on('opentag', (node) => {
      if (node.name === 'programme' && !inProgramme) {
        inProgramme = true;
        progDepth = 1;
        progAttrs = node.attributes ? { ...node.attributes } : {};
        progBody = '';
        serializing = '';
        return;
      }
      if (inProgramme) {
        progDepth++;
        let s = `<${node.name}`;
        if (node.attributes) {
          for (const k of Object.keys(node.attributes)) {
            s += ` ${k}="${escapeXml(node.attributes[k])}"`;
          }
        }
        s += '>';
        serializing += s;
      }
    });
    parser.on('text', (text) => {
      if (inProgramme && progDepth >= 2) serializing += escapeXml(text);
      else if (inProgramme && progDepth === 1) progBody += escapeXml(text);
    });
    parser.on('cdata', (text) => {
      if (inProgramme) {
        const block = `<![CDATA[${text}]]>`;
        if (progDepth >= 2) serializing += block;
        else progBody += block;
      }
    });
    parser.on('closetag', (name) => {
      if (!inProgramme) return;
      if (name === 'programme' && progDepth === 1) {
        const ch = progAttrs && progAttrs.channel;
        const guides = ch ? tvgIdToGuides.get(ch) : null;
        if (guides) {
          for (const g of guides) {
            let attrs = '';
            for (const k of Object.keys(progAttrs)) {
              const v = k === 'channel' ? g : progAttrs[k];
              attrs += ` ${k}="${escapeXml(v)}"`;
            }
            stream.write(`<programme${attrs}>${progBody}${serializing}</programme>\n`);
          }
        }
        inProgramme = false;
        progAttrs = null;
        progBody = '';
        serializing = '';
        progDepth = 0;
      } else {
        progDepth--;
        serializing += `</${name}>`;
      }
    });
    parser.on('error', () => { try { parser._parser.error = null; parser._parser.resume(); } catch (_) { /* noop */ } });
    parser.on('end', () => {
      stream.write('</tv>\n');
      stream.end();
    });
    stream.on('finish', () => {
      try { fs.renameSync(tmp, outFile); resolve({ file: outFile, count: channels.length }); }
      catch (err) { reject(err); }
    });
    stream.on('error', reject);
    src.on('error', reject);
    src.pipe(parser);
  });
}

function ensureListGuideXml(listId) {
  const list = db.prepare('SELECT id, slug, epg_id FROM lists WHERE id = ?').get(listId);
  if (!list || !list.epg_id) return Promise.resolve(null);
  const epg = db.prepare('SELECT * FROM epgs WHERE id = ?').get(list.epg_id);
  const epgFile = resolveEpgFile(epg);
  if (!epgFile) return Promise.resolve(null);
  const guideFile = guideFileForSlug(list.slug);
  const m3uFile = cacheFileForSlug(list.slug);
  let stale = !fs.existsSync(guideFile);
  if (!stale) {
    const guideMtime = fs.statSync(guideFile).mtimeMs;
    if (fs.statSync(epgFile).mtimeMs > guideMtime) stale = true;
    else if (fs.existsSync(m3uFile) && fs.statSync(m3uFile).mtimeMs > guideMtime) stale = true;
  }
  if (stale) return withListLock(listId, () => buildListGuideXml(listId));
  return Promise.resolve({ file: guideFile, cached: true });
}

function removeListGuideCache(slug) {
  if (!slug) return;
  const file = guideFileForSlug(slug);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function removeListLineupCache(slug) {
  if (!slug) return;
  const file = lineupFileForSlug(slug);
  if (fs.existsSync(file)) try { fs.unlinkSync(file); } catch (_) { /* noop */ }
}

async function persistCompiledChannels(listId, channels, onProgress, signal) {
  S('delCompiled').run(listId);
  const ins = S('insCompiled');
  const total = channels.length;
  for (let start = 0; start < total; start += PERSIST_CHUNK) {
    checkAbort(signal);
    const end = Math.min(start + PERSIST_CHUNK, total);
    const tx = db.transaction(() => {
      for (let i = start; i < end; i++) {
        const c = channels[i];
        ins.run(listId, i, c.tvg_id, c.tvg_name, c.tvg_logo, c.group_title, c.display_name, c.url, c.extra_lines, c.duration || '-1');
      }
    });
    tx();
    if (onProgress) onProgress(end, total);
    await tick();
  }
  if (onProgress) onProgress(total, total);
}

async function writeListCache(listId, onStep, signal) {
  return withListLock(listId, async () => {
    const step = (name, done, total) => { if (onStep) onStep(name, done, total); };
    step('filter', 0, 0);
    const result = await buildListResolution(listId, (d, t) => step('filter', d, t), signal);
    if (!result) return null;
    checkAbort(signal);
    const file = cacheFileForSlug(result.list.slug);
    step('write', 0, result.live.length);
    await streamM3UToFile(result.live, file, { onChunk: async (d, t) => {
      checkAbort(signal);
      step('write', d, t);
      await tick();
    } });
    checkAbort(signal);
    step('persist', 0, result.channels.length);
    await persistCompiledChannels(listId, result.channels, (d, t) => step('persist', d, t), signal);
    removeListGuideCache(result.list.slug);
    removeListLineupCache(result.list.slug);
    buildListGuideXml(listId).catch(err => logger.error({ err, listId }, 'guide xml build failed'));
    return { file, count: result.count, slug: result.list.slug };
  });
}

function removeListCache(slug) {
  if (!slug) return;
  const file = cacheFileForSlug(slug);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  removeListGuideCache(slug);
  removeListLineupCache(slug);
}

async function regenerateAllListCaches(reporter, signal) {
  const lists = db.prepare('SELECT id, slug, name FROM lists').all();
  const total = lists.length;
  if (reporter) reporter.setProgress(0, total, 'filter');
  const results = [];
  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < lists.length; i++) {
    checkAbort(signal);
    const l = lists[i];
    if (reporter) reporter.setCurrent(l.name || l.slug, 'filter');
    let r;
    try {
      const out = await writeListCache(l.id, (step, done, sub) => {
        if (reporter) {
          reporter.setProgress(i, total, step);
          reporter.setCounters({ subDone: done, subTotal: sub });
        }
      }, signal);
      r = { id: l.id, ok: true, ...(out || {}) };
      okCount++;
    } catch (err) {
      if (err && (err.aborted || /abort/i.test(err.message || ''))) throw err;
      logger.error({ err, listId: l.id }, 'cache list failed');
      r = { id: l.id, ok: false, error: err.message };
      failCount++;
    }
    results.push(r);
    if (reporter) reporter.setProgress(i + 1, total);
    await tick();
  }
  if (reporter) reporter.setSummary({ ok: okCount, failed: failCount });
  return results;
}

function purgeCompiledChannels(listId) {
  S('delCompiled').run(listId);
}

module.exports = {
  resolveListChannels, loadListConfig,
  writeListCache, removeListCache, regenerateAllListCaches, cacheFileForSlug,
  purgeCompiledChannels,
  rewriteListM3UFromCompiled, rewriteAllListM3UFromCompiled,
  buildListGuideXml, ensureListGuideXml, guideFileForSlug, removeListGuideCache,
  lineupFileForSlug, removeListLineupCache,
  withListLock,
  FIELDS: constants.FIELDS,
  OPERATORS: constants.OPERATORS,
  ACTIONS: constants.ACTIONS,
  COMBINATORS: constants.COMBINATORS,
  CASE_MODES: constants.CASE_MODES,
};
