const { parentPort } = require('worker_threads');
const { normalizeDisplayName, detectQuality } = require('../normalize');
const { ruleMatch } = require('../utils');
const { buildLookupFromData } = require('../epg');

function compileReplacements(replacements) {
  const out = [];
  for (const r of replacements || []) {
    let pattern;
    if (r.is_regex) {
      try { pattern = new RegExp(r.find, 'gi'); } catch { continue; }
    } else {
      const escaped = String(r.find).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      pattern = new RegExp(escaped, 'gi');
    }
    out.push({ field: r.field, pattern, replace: r.replace == null ? '' : String(r.replace) });
  }
  return out;
}

function applyReplacements(channel, compiled) {
  if (!compiled.length) return channel;
  const out = { ...channel };
  for (const r of compiled) {
    const v = out[r.field];
    if (v == null) continue;
    out[r.field] = String(v).replace(r.pattern, r.replace);
  }
  return out;
}

function imageOverrideMatches(override, channel) {
  if (override.source_url && channel.tvg_logo && channel.tvg_logo === override.source_url) return true;
  for (const rule of override.rules) {
    if (ruleMatch(channel, rule)) return true;
  }
  return false;
}

function groupMatch(channel, group, rules) {
  if (rules.length === 0) return false;
  if (group.combinator === 'AND') return rules.every(r => ruleMatch(channel, r));
  return rules.some(r => ruleMatch(channel, r));
}

function applyTransform(c, normOpts, epgLookup, matchedGroup, imageOverrides, brokenSet) {
  const rawDisplay = c.display_name || c.tvg_name || '';
  const rawTvgName = c.tvg_name || '';
  let tvg_id = null;
  let tvg_name = null;
  if (epgLookup) {
    const hit = epgLookup.matchPriority(c)
      || epgLookup.match(rawDisplay)
      || epgLookup.match(rawTvgName);
    if (hit) {
      tvg_id = hit.tvg_id;
      tvg_name = hit.tvg_name;
    }
  }
  const display_name = normalizeDisplayName(rawDisplay, normOpts);
  let group_title = c.group_title;
  if (matchedGroup) {
    const gname = (matchedGroup.group_name || '').trim();
    if (gname) {
      if (matchedGroup.append_quality) {
        const q = detectQuality(rawDisplay, rawTvgName);
        group_title = q ? `${gname} ${q}` : gname;
      } else {
        group_title = gname;
      }
    }
  }
  let tvg_logo = c.tvg_logo;
  if (imageOverrides && imageOverrides.length) {
    const probe = { ...c, display_name, tvg_id: tvg_id || c.tvg_id, tvg_name: tvg_name || c.tvg_name, group_title };
    for (const ov of imageOverrides) {
      if (imageOverrideMatches(ov, probe)) { tvg_logo = ov.target_url; break; }
    }
  }
  if (brokenSet && tvg_logo && brokenSet.has(tvg_logo)) tvg_logo = null;
  return { ...c, tvg_id, tvg_name, display_name, group_title, tvg_logo };
}

const PROGRESS_EVERY = parseInt(process.env.REGEN_YIELD_EVERY || '2000', 10);

function handleResolve(msg) {
  const { jobId, raw, groups, replacements, normOpts, epgData, imageOverrides, brokenList } = msg;
  const epgLookup = epgData ? buildLookupFromData(epgData) : null;
  const compiled = compileReplacements(replacements);
  const brokenSet = brokenList && brokenList.length ? new Set(brokenList) : null;
  const total = raw.length;
  const result = [];
  for (let i = 0; i < total; i++) {
    const replaced = applyReplacements(raw[i], compiled);
    raw[i] = null;
    if (groups.length === 0) {
      result.push(applyTransform(replaced, normOpts, epgLookup, null, imageOverrides, brokenSet));
    } else {
      let matched = null;
      for (const g of groups) {
        if (groupMatch(replaced, g, g.rules)) { matched = g; break; }
      }
      if (matched && matched.action === 'include') {
        result.push(applyTransform(replaced, normOpts, epgLookup, matched, imageOverrides, brokenSet));
      }
    }
    if ((i + 1) % PROGRESS_EVERY === 0) {
      parentPort.postMessage({ type: 'progress', jobId, done: i + 1, total });
    }
  }
  raw.length = 0;
  parentPort.postMessage({ type: 'progress', jobId, done: total, total });
  parentPort.postMessage({ type: 'done', jobId, channels: result });
}

parentPort.on('message', (msg) => {
  if (!msg || msg.type !== 'resolve') return;
  try {
    handleResolve(msg);
  } catch (err) {
    parentPort.postMessage({ type: 'error', jobId: msg.jobId, error: err.message, stack: err.stack });
  }
});
