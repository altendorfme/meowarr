const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { fetch } = require('undici');
const simpleGit = require('simple-git');
const { globby } = require('globby');
const pLimit = require('p-limit').default || require('p-limit');
const db = require('./db');
const config = require('./config');
const { parseM3U } = require('./m3u8parser');
const { indexEpgFromFile, resolveEpgFile } = require('./epg');
const logger = require('./logger');

const SYNC_TIMEOUT_MS = parseInt(process.env.SYNC_TIMEOUT_MS || '300000', 10);
const SYNC_CONCURRENCY = parseInt(process.env.SYNC_CONCURRENCY || '4', 10);
const SYNC_PERSIST_CHUNK = parseInt(process.env.SYNC_PERSIST_CHUNK || '2000', 10);
const tick = () => new Promise(setImmediate);

function checkAbort(signal) {
  if (signal && signal.aborted) {
    const err = new Error('aborted');
    err.aborted = true;
    throw err;
  }
}

function combineSignals(...signals) {
  const ctrl = new AbortController();
  const sources = signals.filter(Boolean);
  const onAbort = (reason) => { try { ctrl.abort(reason); } catch (_) { /* noop */ } };
  for (const s of sources) {
    if (s.aborted) { onAbort(s.reason); break; }
    s.addEventListener('abort', () => onAbort(s.reason), { once: true });
  }
  return { signal: ctrl.signal, cancel: () => ctrl.abort() };
}

async function fetchUrlBuffer(url, signal) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'meowarr/1.0' },
    redirect: 'follow',
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const headers = Object.fromEntries(res.headers);
  return { buf, headers };
}

function maybeGunzip(buf, contentEncoding, urlOrPath) {
  const isGz = /gzip/i.test(contentEncoding || '')
    || /\.gz(\?|$)/i.test(urlOrPath || '')
    || (buf[0] === 0x1f && buf[1] === 0x8b);
  return isGz ? zlib.gunzipSync(buf) : buf;
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) { /* noop */ } }, ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(timer) };
}

async function syncGitSource(source, signal, onStep) {
  const repoDir = path.join(config.reposDir, `src-${source.id}`);
  const git = simpleGit();
  if (onStep) onStep('fetch', 0, 0);
  if (fs.existsSync(path.join(repoDir, '.git'))) {
    const repo = simpleGit(repoDir);
    await repo.fetch(['--all', '--prune']);
    if (signal && signal.aborted) throw new Error('aborted');
    await repo.reset(['--hard', 'origin/HEAD']).catch(async () => repo.pull());
  } else {
    fs.rmSync(repoDir, { recursive: true, force: true });
    await git.clone(source.location, repoDir, ['--depth', '1']);
  }
  if (signal && signal.aborted) throw new Error('aborted');
  const files = await globby(['**/*.m3u', '**/*.m3u8'], {
    cwd: repoDir,
    caseSensitiveMatch: false,
    gitignore: false,
  });
  let total = 0;
  const collected = [];
  for (let i = 0; i < files.length; i++) {
    if (signal && signal.aborted) throw new Error('aborted');
    const rel = files[i];
    const abs = path.join(repoDir, rel);
    const raw = fs.readFileSync(abs);
    const text = maybeGunzip(raw, '', rel).toString('utf8');
    let channels;
    try { channels = parseM3U(text); }
    catch (err) { logger.warn({ err: err.message, file: rel }, 'skipping invalid playlist'); continue; }
    for (const c of channels) collected.push({ ...c, file_path: rel });
    total += channels.length;
    if (onStep) onStep('parse', i + 1, files.length);
    await tick();
  }
  await replaceChannels(source.id, collected, onStep, signal);
  return { files: files.length, channels: total };
}

async function syncUrlSource(source, signal, onStep) {
  if (onStep) onStep('fetch', 0, 0);
  const { buf, headers } = await fetchUrlBuffer(source.location, signal);
  const ct = String(headers['content-type'] || '').toLowerCase();
  if (ct.includes('text/html') || ct.startsWith('application/json')) {
    throw new Error(`URL returned ${ct.split(';')[0] || 'non-playlist content'}; pick "Git repository" if this is a repo URL`);
  }
  const text = maybeGunzip(buf, headers['content-encoding'], source.location).toString('utf8');
  if (onStep) onStep('parse', 0, 0);
  const channels = parseM3U(text).map(c => ({ ...c, file_path: null }));
  await replaceChannels(source.id, channels, onStep, signal);
  return { files: 1, channels: channels.length };
}

async function replaceChannels(sourceId, channels, onStep, signal) {
  const del = db.prepare('DELETE FROM channels WHERE source_id = ?');
  const ins = db.prepare(`INSERT INTO channels
    (source_id, file_path, tvg_id, tvg_name, tvg_logo, group_title, display_name, url, raw_attrs, extra_lines, duration)
    VALUES (@source_id, @file_path, @tvg_id, @tvg_name, @tvg_logo, @group_title, @display_name, @url, @raw_attrs, @extra_lines, @duration)`);
  del.run(sourceId);
  const total = channels.length;
  for (let start = 0; start < total; start += SYNC_PERSIST_CHUNK) {
    checkAbort(signal);
    const end = Math.min(start + SYNC_PERSIST_CHUNK, total);
    const tx = db.transaction(() => {
      for (let i = start; i < end; i++) ins.run({ source_id: sourceId, ...channels[i] });
    });
    tx();
    if (onStep) onStep('persist', end, total);
    await tick();
  }
}

async function syncSource(sourceId, onStep, parentSignal) {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(sourceId);
  if (!source) throw new Error(`source ${sourceId} not found`);
  const upd = db.prepare("UPDATE sources SET last_sync_at = datetime('now'), last_status = ?, last_error = ? WHERE id = ?");
  const t = withTimeout(SYNC_TIMEOUT_MS);
  const combined = combineSignals(t.signal, parentSignal);
  try {
    const result = source.kind === 'git'
      ? await syncGitSource(source, combined.signal, onStep)
      : await syncUrlSource(source, combined.signal, onStep);
    upd.run(`ok: ${result.files} file(s), ${result.channels} channel(s)`, null, sourceId);
    return result;
  } catch (err) {
    upd.run('error', err.message, sourceId);
    throw err;
  } finally {
    t.cancel();
    combined.cancel();
  }
}

async function syncMany(items, reporter, signal, fallbackPrefix, runOne) {
  if (reporter) reporter.setProgress(0, items.length, 'fetch');
  const limit = pLimit(SYNC_CONCURRENCY);
  let okCount = 0;
  let failCount = 0;
  let done = 0;
  const results = await Promise.all(items.map(item => limit(async () => {
    checkAbort(signal);
    if (reporter) reporter.setCurrent(item.name || `${fallbackPrefix}:${item.id}`, 'fetch');
    let r;
    try {
      r = { id: item.id, ok: true, ...(await runOne(item, (step, sd, st) => {
        if (reporter) reporter.setCounters({ subDone: sd, subTotal: st, step });
      }, signal)) };
      okCount++;
    } catch (err) {
      if (err && (err.aborted || /abort/i.test(err.message || ''))) throw err;
      r = { id: item.id, ok: false, error: err.message };
      failCount++;
    }
    done++;
    if (reporter) reporter.setProgress(done, items.length);
    return r;
  })));
  if (reporter) reporter.setSummary({ ok: okCount, failed: failCount });
  return results;
}

async function syncAllSources(reporter, signal) {
  const sources = db.prepare('SELECT id, name FROM sources WHERE enabled = 1').all();
  return syncMany(sources, reporter, signal, 'source', (s, onStep, sig) => syncSource(s.id, onStep, sig));
}

async function syncEpg(epgId, onStep, parentSignal) {
  const epg = db.prepare('SELECT * FROM epgs WHERE id = ?').get(epgId);
  if (!epg) throw new Error(`epg ${epgId} not found`);
  const upd = db.prepare("UPDATE epgs SET last_sync_at = datetime('now'), last_status = ?, last_error = ?, cached_file = COALESCE(?, cached_file) WHERE id = ?");
  const target = path.join(config.epgCacheDir, `${epg.slug}.xml`);
  const tmp = `${target}.tmp`;
  const t = withTimeout(SYNC_TIMEOUT_MS);
  const combined = combineSignals(t.signal, parentSignal);
  try {
    if (onStep) onStep('fetch', 0, 0);
    const { buf, headers } = await fetchUrlBuffer(epg.url, combined.signal);
    checkAbort(combined.signal);
    const xml = maybeGunzip(buf, headers['content-encoding'], epg.url);
    fs.writeFileSync(tmp, xml);
    fs.renameSync(tmp, target);
    await tick();
    checkAbort(combined.signal);
    if (onStep) onStep('index', 0, 0);
    let indexInfo = null;
    try {
      indexInfo = await indexEpgFromFile(epgId, target);
    } catch (idxErr) {
      logger.error({ err: idxErr, epgId }, 'EPG index failed');
    }
    const status = indexInfo
      ? `ok: ${(xml.length / 1024).toFixed(0)} KB, ${indexInfo.channels} channel(s)`
      : 'ok';
    upd.run(status, null, target, epgId);
    return { bytes: xml.length, path: target, ...(indexInfo || {}) };
  } catch (err) {
    upd.run('error (using previous cache)', err.message, null, epgId);
    throw err;
  } finally {
    t.cancel();
    combined.cancel();
  }
}

async function syncAllEpgs(reporter, signal) {
  const epgs = db.prepare('SELECT id, name FROM epgs WHERE enabled = 1').all();
  return syncMany(epgs, reporter, signal, 'epg', (e, onStep, sig) => syncEpg(e.id, onStep, sig));
}

async function reindexAllEpgs() {
  const epgs = db.prepare('SELECT id, slug, cached_file FROM epgs').all();
  const results = [];
  for (const e of epgs) {
    const file = resolveEpgFile(e);
    if (!file) {
      results.push({ id: e.id, ok: false, error: 'file not found' });
      continue;
    }
    try {
      const info = await indexEpgFromFile(e.id, file);
      db.prepare("UPDATE epgs SET cached_file = ? WHERE id = ?").run(file, e.id);
      results.push({ id: e.id, ok: true, file, ...info });
    } catch (err) {
      results.push({ id: e.id, ok: false, error: err.message });
    }
  }
  return results;
}

module.exports = { syncSource, syncAllSources, syncEpg, syncAllEpgs, reindexAllEpgs };
