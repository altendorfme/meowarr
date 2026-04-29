const fs = require('fs');
const path = require('path');
const sax = require('sax');
const db = require('./db');
const config = require('./config');
const { epgNormalize, epgTokens, epgQuality } = require('./normalize');
const { ruleMatch } = require('./utils');
const logger = require('./logger');

function resolveEpgFile(epg) {
  if (!epg) return null;
  const local = path.join(config.epgCacheDir, `${epg.slug}.xml`);
  if (fs.existsSync(local)) return local;
  if (epg.cached_file && fs.existsSync(epg.cached_file)) return epg.cached_file;
  return null;
}

function indexEpgFromFile(epgId, file) {
  if (!fs.existsSync(file)) return Promise.resolve({ channels: 0, names: 0 });

  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: true });
    const stream = fs.createReadStream(file, { encoding: 'utf8' });

    let inChannel = false;
    let currentTvgId = null;
    let inDisplayName = false;
    let displayBuf = '';
    let collectedNames = [];

    let totalChannels = 0;
    let totalNames = 0;

    const ins = db.prepare('INSERT INTO epg_channels (epg_id, tvg_id, display_name, normalized) VALUES (?, ?, ?, ?)');
    const del = db.prepare('DELETE FROM epg_channels WHERE epg_id = ?');
    del.run(epgId);

    let pending = [];
    const FLUSH_AT = 1000;

    function flushBatch() {
      if (pending.length === 0) return;
      const tx = db.transaction((rows) => {
        for (const r of rows) ins.run(epgId, r.tvg_id, r.display_name, r.normalized);
      });
      tx(pending);
      totalNames += pending.length;
      pending = [];
    }

    parser.on('opentag', (node) => {
      if (node.name === 'channel') {
        inChannel = true;
        currentTvgId = (node.attributes && node.attributes.id) ? String(node.attributes.id).trim() : null;
        collectedNames = [];
      } else if (inChannel && node.name === 'display-name') {
        inDisplayName = true;
        displayBuf = '';
      }
    });

    parser.on('text', (text) => {
      if (inDisplayName) displayBuf += text;
    });
    parser.on('cdata', (text) => {
      if (inDisplayName) displayBuf += text;
    });

    parser.on('closetag', (name) => {
      if (name === 'display-name' && inDisplayName) {
        const cleaned = displayBuf.replace(/\s+/g, ' ').trim();
        if (cleaned) collectedNames.push(cleaned);
        inDisplayName = false;
        displayBuf = '';
      } else if (name === 'channel' && inChannel) {
        if (currentTvgId) {
          totalChannels++;
          const seen = new Set();
          for (const n of collectedNames) {
            const norm = epgNormalize(n);
            if (!norm || seen.has(norm)) continue;
            seen.add(norm);
            pending.push({ tvg_id: currentTvgId, display_name: n, normalized: norm });
            if (pending.length >= FLUSH_AT) flushBatch();
          }
        }
        inChannel = false;
        currentTvgId = null;
        collectedNames = [];
      }
    });

    parser.on('error', (err) => {
      try { parser._parser.error = null; parser._parser.resume(); } catch (_) { /* noop */ }
      logger.warn({ err: err.message, file }, 'EPG SAX parse warning, continuing');
    });

    parser.on('end', () => {
      flushBatch();
      resolve({ channels: totalChannels, names: totalNames });
    });

    stream.on('error', reject);
    stream.pipe(parser);
  });
}

function loadLookupData(epgId) {
  if (!epgId) return null;
  const rows = db.prepare(`
    SELECT tvg_id, display_name, normalized
    FROM epg_channels
    WHERE epg_id = ?
    ORDER BY id
  `).all(epgId);

  const priorities = db.prepare(`
    SELECT id, tvg_id, display_name, combinator
    FROM epg_priorities
    WHERE epg_id = ?
    ORDER BY position, id
  `).all(epgId);

  const rulesByPri = new Map();
  if (priorities.length > 0) {
    const ph = priorities.map(() => '?').join(',');
    const ruleRows = db.prepare(`
      SELECT priority_id, field, operator, value
      FROM epg_priority_rules
      WHERE priority_id IN (${ph})
      ORDER BY position, id
    `).all(...priorities.map(p => p.id));
    for (const r of ruleRows) {
      if (!rulesByPri.has(r.priority_id)) rulesByPri.set(r.priority_id, []);
      rulesByPri.get(r.priority_id).push(r);
    }
  }
  return { rows, priorities, rulesByPri };
}

function buildLookupFromData(data) {
  if (!data) return null;
  const { rows, priorities, rulesByPri } = data;

  const byNorm = new Map();
  const firstNameByTvg = new Map();
  const entries = [];
  const tokenIndex = new Map();

  for (const r of rows) {
    const quality = epgQuality(r.display_name);
    if (!byNorm.has(r.normalized)) byNorm.set(r.normalized, []);
    byNorm.get(r.normalized).push({ ...r, quality });
    if (!firstNameByTvg.has(r.tvg_id)) firstNameByTvg.set(r.tvg_id, r.display_name);
    const tokens = epgTokens(r.display_name);
    const entry = {
      tvg_id: r.tvg_id,
      display_name: r.display_name,
      tokens,
      tokenSet: new Set(tokens),
      quality,
    };
    entries.push(entry);
    for (const tok of tokens) {
      let bucket = tokenIndex.get(tok);
      if (!bucket) { bucket = []; tokenIndex.set(tok, bucket); }
      bucket.push(entry);
    }
  }

  function qualityScore(inQ, epgQ) {
    if (inQ === epgQ) return 3;
    if (inQ && !epgQ) return 2;
    if (!inQ && epgQ) return 1;
    return 0;
  }

  return {
    matchPriority(channel) {
      if (!channel || priorities.length === 0) return null;
      for (const p of priorities) {
        const rules = rulesByPri.get(p.id) || [];
        if (rules.length === 0) continue;
        const ok = p.combinator === 'AND'
          ? rules.every(r => ruleMatch(channel, r))
          : rules.some(r => ruleMatch(channel, r));
        if (ok) {
          return {
            tvg_id: p.tvg_id,
            tvg_name: firstNameByTvg.get(p.tvg_id) || p.display_name || p.tvg_id,
          };
        }
      }
      return null;
    },
    match(name) {
      if (!name) return null;
      const inQuality = epgQuality(name);
      const norm = epgNormalize(name);
      if (norm) {
        const candidates = byNorm.get(norm);
        if (candidates && candidates.length) {
          let pick = candidates[0];
          let pickScore = qualityScore(inQuality, pick.quality);
          for (let i = 1; i < candidates.length; i++) {
            const sc = qualityScore(inQuality, candidates[i].quality);
            if (sc > pickScore) { pick = candidates[i]; pickScore = sc; }
          }
          return { tvg_id: pick.tvg_id, tvg_name: firstNameByTvg.get(pick.tvg_id) || pick.display_name };
        }
      }
      const inTokens = epgTokens(name);
      if (inTokens.length === 0) return null;
      const seedToken = inTokens.reduce((a, b) => {
        const ba = tokenIndex.get(a) ? tokenIndex.get(a).length : Infinity;
        const bb = tokenIndex.get(b) ? tokenIndex.get(b).length : Infinity;
        return bb < ba ? b : a;
      });
      const candidates = tokenIndex.get(seedToken);
      if (!candidates || candidates.length === 0) return null;
      let best = null;
      let bestDiff = Infinity;
      let bestQScore = -1;
      let ambiguous = false;
      for (const e of candidates) {
        if (e.tokens.length < inTokens.length) continue;
        let allIn = true;
        for (const t of inTokens) {
          if (!e.tokenSet.has(t)) { allIn = false; break; }
        }
        if (!allIn) continue;
        const diff = e.tokens.length - inTokens.length;
        const qScore = qualityScore(inQuality, e.quality);
        if (diff < bestDiff || (diff === bestDiff && qScore > bestQScore)) {
          best = e;
          bestDiff = diff;
          bestQScore = qScore;
          ambiguous = false;
        } else if (diff === bestDiff && qScore === bestQScore && best && best.tvg_id !== e.tvg_id) {
          ambiguous = true;
        }
      }
      if (!best || ambiguous) return null;
      return { tvg_id: best.tvg_id, tvg_name: firstNameByTvg.get(best.tvg_id) || best.display_name };
    },
  };
}

function buildLookup(epgId) {
  return buildLookupFromData(loadLookupData(epgId));
}

module.exports = { indexEpgFromFile, buildLookup, loadLookupData, buildLookupFromData, resolveEpgFile };
