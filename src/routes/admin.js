const fs = require('fs');
const path = require('path');
const express = require('express');
const db = require('../db');
const config = require('../config');
const logger = require('../logger');
const { syncSource, syncAllSources, syncEpg, syncAllEpgs } = require('../sync');
const {
  writeListCache, removeListCache, regenerateAllListCaches,
  loadListConfig, purgeCompiledChannels,
  rewriteListM3UFromCompiled,
} = require('../filters');
const {
  FIELDS, OPERATORS, ACTIONS, COMBINATORS, CASE_MODES,
  FIELDS_SET, OPERATORS_SET, ACTIONS_SET, COMBINATORS_SET, CASE_MODES_SET,
} = require('../constants');
const { slugify, parseRulesArray, publicBaseUrl } = require('../utils');
const { encryptString, decryptString } = require('../crypto');
const { proxyCheck, proxyStream } = require('../proxy');
const jobs = require('../jobs');

function wantsJson(req) {
  const accept = String(req.get('accept') || '').toLowerCase();
  return req.xhr || accept.includes('application/json');
}

function jobResponse(req, res, result, redirect) {
  if (wantsJson(req)) {
    if (!result.ok) {
      return res.status(409).json({ ok: false, alreadyRunning: true, current: result.current });
    }
    return res.status(202).json({ ok: true, job: result.job });
  }
  res.redirect(redirect);
}

function enqueueResourceJob({ type, label, current, runOne }) {
  return jobs.enqueueServerJob({
    type,
    label,
    run: ({ signal, reporter }) => {
      reporter.setProgress(0, 1, 'fetch');
      reporter.setCurrent(current);
      return runOne((step, sd, st) => {
        reporter.setCounters({ subDone: sd, subTotal: st, step });
        reporter.setProgress(0, 1, step);
      }, signal).then((r) => {
        reporter.setProgress(1, 1);
        reporter.setSummary({ ok: 1, failed: 0 });
        return r;
      });
    },
  });
}

function markBrokenUrl(table, url, broken) {
  db.prepare(`
    INSERT INTO ${table} (url, broken, checked_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(url) DO UPDATE SET broken = excluded.broken, checked_at = excluded.checked_at
  `).run(url, broken);
}

function parseBroken(v) {
  return v === true || v === 1 || v === '1' ? 1 : 0;
}

const router = express.Router();

router.get('/api/jobs/current', (req, res) => {
  res.json(jobs.snapshot());
});

router.post('/api/jobs/:id/cancel', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ ok: false });
  const result = jobs.cancel(id);
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

router.post('/api/jobs/client/start', (req, res) => {
  const { type, label, total } = req.body || {};
  if (!type) return res.status(400).json({ ok: false, error: 'type required' });
  const result = jobs.startClientJob({
    type: String(type),
    label: label ? String(label) : null,
    total: Number(total) || 0,
  });
  if (!result.ok) return res.status(409).json({ ok: false, alreadyRunning: true, current: result.current });
  res.status(202).json({ ok: true, job: result.job });
});

router.post('/api/jobs/client/:id/heartbeat', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = jobs.heartbeatClientJob(id, req.body || {});
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

router.post('/api/jobs/client/:id/finish', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const result = jobs.finishClientJob(id, req.body || {});
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

router.get('/', (req, res) => {
  const sources = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM channels WHERE source_id = s.id) AS channel_count
    FROM sources s ORDER BY s.id DESC
  `).all();
  const lists = db.prepare(`
    SELECT l.*, e.slug AS epg_slug, e.name AS epg_name
    FROM lists l
    LEFT JOIN epgs e ON e.id = l.epg_id
    ORDER BY l.id DESC
  `).all().map(l => ({ ...l, basic_auth_password: l.basic_auth_password ? decryptString(l.basic_auth_password) : null }));
  const epgs = db.prepare('SELECT * FROM epgs ORDER BY id DESC').all();
  const baseUrl = publicBaseUrl(req, config.publicBaseUrl);
  res.render('dashboard', { sources, lists, epgs, baseUrl });
});

router.get('/sources', (req, res) => {
  const sources = db.prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM channels WHERE source_id = s.id) AS channel_count
    FROM sources s ORDER BY s.id DESC
  `).all();
  res.render('sources', { sources });
});

router.post('/sources', (req, res) => {
  const { name, kind, location, enabled } = req.body;
  if (!['git', 'url'].includes(kind)) return res.status(400).send(res.locals.t('errors.invalidKind'));
  db.prepare('INSERT INTO sources (name, kind, location, enabled) VALUES (?, ?, ?, ?)')
    .run(name, kind, location, enabled ? 1 : 0);
  res.redirect('/sources');
});

router.post('/sources/sync-all', (req, res) => {
  const result = jobs.enqueueServerJob({
    type: 'sync-sources',
    label: res.locals.t('jobs.syncAllSources'),
    run: ({ signal, reporter }) => syncAllSources(reporter, signal),
  });
  return jobResponse(req, res, result, '/sources');
});

router.get('/sources/:id/edit', (req, res) => {
  const t = res.locals.t;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(404).send(t('errors.sourceNotFound'));
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  if (!source) return res.status(404).send(t('errors.sourceNotFound'));
  res.render('source_edit', { source, saved: req.query.saved === '1', error: null });
});

router.post('/sources/:id', (req, res) => {
  const t = res.locals.t;
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(404).send(t('errors.sourceNotFound'));
  const existing = db.prepare('SELECT * FROM sources WHERE id = ?').get(id);
  if (!existing) return res.status(404).send(t('errors.sourceNotFound'));

  const { name, kind, location, enabled } = req.body;
  const renderError = (message) => res.status(400).render('source_edit', {
    source: { ...existing, name: name || existing.name, kind: kind || existing.kind, location: location || existing.location, enabled: enabled ? 1 : 0 },
    saved: false, error: message,
  });

  if (!name || !name.trim()) return renderError(t('sourceEdit.nameRequired'));
  if (!['git', 'url'].includes(kind)) return renderError(t('errors.invalidKind'));
  if (!location || !location.trim()) return renderError(t('sourceEdit.locationRequired'));

  const locationChanged = existing.location !== location.trim() || existing.kind !== kind;
  try {
    db.prepare('UPDATE sources SET name = ?, kind = ?, location = ?, enabled = ? WHERE id = ?')
      .run(name.trim(), kind, location.trim(), enabled ? 1 : 0, id);
  } catch (err) {
    return renderError(err.message);
  }

  if (locationChanged) {
    const repoDir = path.join(config.reposDir, `src-${id}`);
    try { fs.rmSync(repoDir, { recursive: true, force: true }); }
    catch (err) { logger.error({ err, sourceId: id }, 'source repo cleanup after edit failed'); }
    db.prepare('DELETE FROM channels WHERE source_id = ?').run(id);
  }

  res.redirect(`/sources/${id}/edit?saved=1`);
});

router.post('/sources/:id/delete', (req, res) => {
  const sourceId = parseInt(req.params.id, 10);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM channels WHERE source_id = ?').run(sourceId);
    db.prepare('DELETE FROM sources WHERE id = ?').run(sourceId);
    db.prepare('DELETE FROM list_sources WHERE source_id = ?').run(sourceId);
  });
  tx();
  const repoDir = path.join(config.reposDir, `src-${sourceId}`);
  try { fs.rmSync(repoDir, { recursive: true, force: true }); }
  catch (err) { logger.error({ err, sourceId }, 'source cache cleanup failed'); }
  res.redirect('/sources');
});

router.post('/sources/:id/toggle', (req, res) => {
  db.prepare('UPDATE sources SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  res.redirect('/sources');
});

router.post('/sources/:id/sync', (req, res) => {
  const sourceId = parseInt(req.params.id, 10);
  const source = db.prepare('SELECT name FROM sources WHERE id = ?').get(sourceId);
  const result = enqueueResourceJob({
    type: `sync-source:${sourceId}`,
    label: res.locals.t('jobs.syncSource', { name: source ? source.name : `#${sourceId}` }),
    current: source ? source.name : `source:${sourceId}`,
    runOne: (onStep, signal) => syncSource(sourceId, onStep, signal),
  });
  return jobResponse(req, res, result, '/sources');
});

function paginate(req, perPageDefault = 1000) {
  const PER_PAGE = perPageDefault;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const q = (req.query.q || '').trim();
  return { PER_PAGE, page, q };
}

router.get('/sources/:id/channels', (req, res) => {
  const source = db.prepare('SELECT * FROM sources WHERE id = ?').get(req.params.id);
  if (!source) return res.status(404).send(res.locals.t('errors.sourceNotFound'));
  const { PER_PAGE, page, q } = paginate(req);
  const params = [req.params.id];
  let where = 'source_id = ?';
  if (q) {
    where += ' AND (tvg_id LIKE ? OR tvg_name LIKE ? OR display_name LIKE ? OR group_title LIKE ? OR url LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  const total = db.prepare(`SELECT COUNT(*) AS c FROM channels WHERE ${where}`).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * PER_PAGE;
  const channels = db.prepare(
    `SELECT * FROM channels WHERE ${where} ORDER BY group_title, display_name LIMIT ? OFFSET ?`
  ).all(...params, PER_PAGE, offset);
  res.render('sources_channels', { source, channels, q, page: currentPage, totalPages, total, perPage: PER_PAGE });
});

router.get('/lists', (req, res) => {
  const lists = db.prepare(`
    SELECT l.*,
      (SELECT COUNT(*) FROM list_groups WHERE list_id = l.id) AS group_count,
      (SELECT name FROM epgs WHERE id = l.epg_id) AS epg_name
    FROM lists l ORDER BY l.id DESC
  `).all();
  res.render('lists', { lists, regenerated: req.query.regenerated === '1' });
});

router.post('/lists/regen-all', (req, res) => {
  const result = jobs.enqueueServerJob({
    type: 'regen-lists',
    label: res.locals.t('jobs.regenAllLists'),
    run: ({ signal, reporter }) => regenerateAllListCaches(reporter, signal),
  });
  return jobResponse(req, res, result, '/lists?regenerated=1');
});

router.post('/lists/:id/regen', (req, res) => {
  const listId = parseInt(req.params.id, 10);
  const list = db.prepare('SELECT name FROM lists WHERE id = ?').get(listId);
  const result = enqueueResourceJob({
    type: `regen-list:${listId}`,
    label: res.locals.t('jobs.regenList', { name: list ? list.name : `#${listId}` }),
    current: list ? list.name : `list:${listId}`,
    runOne: (onStep, signal) => writeListCache(listId, onStep, signal),
  });
  return jobResponse(req, res, result, '/lists?regenerated=1');
});

router.get('/lists/new', (req, res) => {
  res.render('list_new', { error: null, values: { name: '', slug: '', description: '' } });
});

router.post('/lists', (req, res) => {
  const { name, slug, description } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).render('list_new', {
      error: res.locals.t('listNew.nameRequired'),
      values: { name, slug, description },
    });
  }
  const finalSlug = slugify(slug || name);
  try {
    const info = db.prepare('INSERT INTO lists (slug, name, description) VALUES (?, ?, ?)')
      .run(finalSlug, name.trim(), description ? description.trim() : null);
    res.redirect(`/lists/${info.lastInsertRowid}/edit`);
  } catch (err) {
    res.status(400).render('list_new', { error: err.message, values: { name, slug, description } });
  }
});

router.get('/lists/:id/edit', (req, res) => {
  const cfg = loadListConfig(parseInt(req.params.id, 10));
  if (!cfg) return res.status(404).send(res.locals.t('listEdit.listNotFound'));
  const sources = db.prepare('SELECT * FROM sources ORDER BY name').all();
  const epgs = db.prepare('SELECT id, name, slug FROM epgs ORDER BY name').all();
  const list = { ...cfg.list, basic_auth_password: cfg.list.basic_auth_password ? decryptString(cfg.list.basic_auth_password) : '' };
  res.render('list_edit', {
    list,
    groups: cfg.groups,
    replacements: cfg.replacements,
    linkedSourceIds: cfg.linkedSourceIds,
    sources,
    epgs,
    FIELDS, OPERATORS, ACTIONS, COMBINATORS, CASE_MODES,
    saved: req.query.saved === '1',
    error: null,
  });
});

function parseReplacementsPayload(raw, t) {
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(t('errors.invalidReplacementsJson')); }
  if (!Array.isArray(parsed)) throw new Error(t('errors.replacementsMustBeArray'));
  return parsed.map((r, i) => {
    const field = String(r.field || '').trim();
    const find = String(r.find == null ? '' : r.find);
    const replace = String(r.replace == null ? '' : r.replace);
    const isRegex = r.is_regex ? 1 : 0;
    if (!FIELDS_SET.has(field)) throw new Error(`${t('listEdit.replacement')} ${i + 1}: invalid field`);
    if (!find.length) throw new Error(t('errors.replacementFindRequired', { n: i + 1 }));
    if (isRegex) {
      try { new RegExp(find); } catch { throw new Error(`${t('listEdit.replacement')} ${i + 1}: invalid regex`); }
    }
    return { field, find, replace, is_regex: isRegex };
  });
}

function parseGroupsPayload(raw, t) {
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(t('errors.invalidGroupsJson')); }
  if (!Array.isArray(parsed)) throw new Error(t('errors.groupsMustBeArray'));
  return parsed.map((g, gi) => {
    const action = String(g.action || '').toLowerCase();
    const combinator = String(g.combinator || '').toUpperCase();
    if (!ACTIONS_SET.has(action)) throw new Error(`Group ${gi + 1}: invalid action`);
    if (!COMBINATORS_SET.has(combinator)) throw new Error(`Group ${gi + 1}: invalid combinator`);
    const cleanRules = parseRulesArray(Array.isArray(g.rules) ? g.rules : [], `Group ${gi + 1} rule`);
    let groupName = null;
    let appendQuality = 0;
    if (action === 'include') {
      const v = g.group_name != null ? String(g.group_name).trim() : '';
      if (v.length) groupName = v;
      appendQuality = g.append_quality ? 1 : 0;
    }
    return { action, combinator, rules: cleanRules, group_name: groupName, append_quality: appendQuality };
  });
}

router.post('/lists/:id', (req, res) => {
  const t = res.locals.t;
  const listId = parseInt(req.params.id, 10);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
  if (!list) return res.status(404).send(t('listEdit.listNotFound'));

  const { name, slug, description, sourceIds, groups_json, replacements_json, epg_id, norm_case, norm_strip_specials, basic_auth_user, basic_auth_password } = req.body;
  const renderError = (message) => {
    const sources = db.prepare('SELECT * FROM sources ORDER BY name').all();
    const epgs = db.prepare('SELECT id, name, slug FROM epgs ORDER BY name').all();
    let groups = [];
    try { groups = parseGroupsPayload(groups_json, t); } catch { /* show raw fallback */ }
    let replacements = [];
    try { replacements = parseReplacementsPayload(replacements_json, t); } catch { /* show raw fallback */ }
    res.status(400).render('list_edit', {
      list: {
        ...list,
        name: name || list.name,
        slug: slug || list.slug,
        description: description || list.description,
        epg_id: epg_id ? parseInt(epg_id, 10) : null,
        norm_case: norm_case || list.norm_case,
        norm_strip_specials: norm_strip_specials ? 1 : 0,
        basic_auth_user: basic_auth_user || '',
        basic_auth_password: basic_auth_password || '',
      },
      groups: groups.map((g, i) => ({
        ...g,
        id: -i - 1, position: i,
        rules: g.rules.map((r, j) => ({ ...r, id: -j - 1, position: j })),
      })),
      replacements: replacements.map((r, i) => ({ ...r, id: -i - 1, position: i })),
      linkedSourceIds: (Array.isArray(sourceIds) ? sourceIds : (sourceIds ? [sourceIds] : [])).map(v => parseInt(v, 10)),
      sources, epgs,
      FIELDS, OPERATORS, ACTIONS, COMBINATORS, CASE_MODES,
      saved: false, error: message,
    });
  };

  if (!name || !name.trim()) return renderError(t('listEdit.nameRequired'));
  let groups;
  try { groups = parseGroupsPayload(groups_json, t); } catch (err) { return renderError(err.message); }
  let replacements;
  try { replacements = parseReplacementsPayload(replacements_json, t); } catch (err) { return renderError(err.message); }

  const finalSlug = slugify(slug || name);
  const oldSlug = list.slug;
  const caseMode = CASE_MODES_SET.has(norm_case) ? norm_case : 'none';
  const stripSpecials = norm_strip_specials ? 1 : 0;
  const epgIdValue = epg_id ? parseInt(epg_id, 10) : null;
  const epgIdSafe = (epgIdValue && Number.isFinite(epgIdValue)) ? epgIdValue : null;
  const authUser = basic_auth_user ? String(basic_auth_user).trim() : '';
  const authPass = basic_auth_password != null ? String(basic_auth_password) : '';
  const authUserSafe = authUser.length ? authUser : null;
  const authPassSafe = authUser.length ? encryptString(authPass) : null;
  if (authUser.includes(':')) return renderError(t('listEdit.basicAuthColonError'));

  const tx = db.transaction(() => {
    db.prepare(`UPDATE lists SET
      name = ?, slug = ?, description = ?,
      norm_case = ?, norm_strip_specials = ?, epg_id = ?,
      basic_auth_user = ?, basic_auth_password = ?
      WHERE id = ?`)
      .run(name.trim(), finalSlug, description ? description.trim() : null,
        caseMode, stripSpecials, epgIdSafe, authUserSafe, authPassSafe, listId);

    db.prepare('DELETE FROM list_sources WHERE list_id = ?').run(listId);
    const linkIns = db.prepare('INSERT INTO list_sources (list_id, source_id) VALUES (?, ?)');
    const ids = Array.isArray(sourceIds) ? sourceIds : (sourceIds ? [sourceIds] : []);
    for (const sid of ids) {
      const intId = parseInt(sid, 10);
      if (Number.isFinite(intId)) linkIns.run(listId, intId);
    }

    db.prepare('DELETE FROM list_rules WHERE list_id = ?').run(listId);
    db.prepare('DELETE FROM list_groups WHERE list_id = ?').run(listId);
    db.prepare('DELETE FROM list_replacements WHERE list_id = ?').run(listId);

    const repIns = db.prepare(`INSERT INTO list_replacements
      (list_id, field, find, replace, is_regex, position)
      VALUES (?, ?, ?, ?, ?, ?)`);
    replacements.forEach((r, ri) => {
      repIns.run(listId, r.field, r.find, r.replace, r.is_regex, ri);
    });

    const groupIns = db.prepare(`INSERT INTO list_groups
      (list_id, action, combinator, position, group_name, append_quality)
      VALUES (?, ?, ?, ?, ?, ?)`);
    const ruleIns = db.prepare('INSERT INTO list_rules (list_id, group_id, field, operator, value, position) VALUES (?, ?, ?, ?, ?, ?)');
    groups.forEach((g, gi) => {
      const info = groupIns.run(listId, g.action, g.combinator, gi, g.group_name, g.append_quality);
      g.rules.forEach((r, ri) => {
        ruleIns.run(listId, info.lastInsertRowid, r.field, r.operator, r.value, ri);
      });
    });
  });

  try { tx(); } catch (err) { return renderError(err.message); }

  if (oldSlug !== finalSlug) removeListCache(oldSlug);
  res.redirect(`/lists/${listId}/edit?saved=1`);
});

router.get('/lists/:id/channels', async (req, res) => {
  const listId = parseInt(req.params.id, 10);
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(listId);
  if (!list) return res.status(404).send(res.locals.t('errors.listNotFound'));

  const compiledCount = db.prepare('SELECT COUNT(*) AS c FROM compiled_channels WHERE list_id = ?').get(listId).c;
  if (compiledCount === 0) {
    try { await writeListCache(listId); }
    catch (err) { logger.error({ err, listId }, 'compile-on-demand failed'); }
  }

  const { PER_PAGE, page, q } = paginate(req);
  const group = (req.query.group || '').trim();
  const filter = req.query.filter === 'broken' ? 'broken' : (req.query.filter === 'live' ? 'live' : 'all');
  const params = [listId];
  let where = 'c.list_id = ?';
  if (q) {
    where += " AND (IFNULL(c.tvg_id,'') LIKE ? OR IFNULL(c.tvg_name,'') LIKE ? OR IFNULL(c.display_name,'') LIKE ? OR IFNULL(c.group_title,'') LIKE ? OR IFNULL(c.url,'') LIKE ?)";
    const like = `%${q}%`;
    params.push(like, like, like, like, like);
  }
  if (group) {
    where += ' AND IFNULL(c.group_title,\'\') = ?';
    params.push(group);
  }
  if (filter === 'broken') {
    where += ' AND COALESCE(b.broken,0) = 1';
  } else if (filter === 'live') {
    where += ' AND COALESCE(b.broken,0) = 0';
  }
  const baseFrom = `FROM compiled_channels c LEFT JOIN broken_urls b ON b.url = c.url`;
  const total = db.prepare(`SELECT COUNT(*) AS c ${baseFrom} WHERE ${where}`).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * PER_PAGE;
  const channels = db.prepare(
    `SELECT c.*, COALESCE(b.broken,0) AS broken, b.checked_at AS checked_at ${baseFrom}
     WHERE ${where}
     ORDER BY c.group_title COLLATE NOCASE, c.display_name COLLATE NOCASE
     LIMIT ? OFFSET ?`
  ).all(...params, PER_PAGE, offset);
  const groups = db.prepare(`
    SELECT IFNULL(group_title,'') AS group_title, COUNT(*) AS uses
    FROM compiled_channels
    WHERE list_id = ?
    GROUP BY IFNULL(group_title,'')
    ORDER BY group_title COLLATE NOCASE
  `).all(listId);
  const brokenTotal = db.prepare(`
    SELECT COUNT(*) AS c FROM compiled_channels c
    JOIN broken_urls b ON b.url = c.url AND b.broken = 1
    WHERE c.list_id = ?
  `).get(listId).c;
  res.render('list_channels', {
    list, channels, q, group, groups, filter, brokenTotal,
    page: currentPage, totalPages, total, perPage: PER_PAGE,
  });
});

router.get('/lists/:id/check/all.json', (req, res) => {
  const listId = parseInt(req.params.id, 10);
  const list = db.prepare('SELECT id FROM lists WHERE id = ?').get(listId);
  if (!list) return res.status(404).json({ error: res.locals.t('errors.listNotFound') });
  const rows = db.prepare(`
    SELECT DISTINCT url FROM compiled_channels
    WHERE list_id = ? AND url IS NOT NULL AND url != ''
    ORDER BY url
  `).all(listId);
  res.json({ urls: rows.map(r => r.url) });
});

router.post('/lists/:id/check', (req, res) => {
  const listId = parseInt(req.params.id, 10);
  const list = db.prepare('SELECT id FROM lists WHERE id = ?').get(listId);
  if (!list) return res.status(404).json({ error: res.locals.t('errors.listNotFound') });
  const url = String(req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: res.locals.t('errors.urlRequired') });
  const broken = parseBroken(req.body.broken);
  markBrokenUrl('broken_urls', url, broken);
  res.json({ ok: true, url, broken });
});

router.post('/lists/:id/check/rewrite', async (req, res) => {
  const listId = parseInt(req.params.id, 10);
  try { await rewriteListM3UFromCompiled(listId); }
  catch (err) { logger.error({ err, listId }, 'rewrite m3u failed'); return res.status(500).json({ error: 'rewrite failed' }); }
  res.json({ ok: true });
});

router.get('/proxy/check', proxyCheck);
router.get('/proxy/stream', proxyStream);

router.post('/lists/:id/delete', (req, res) => {
  const listId = parseInt(req.params.id, 10);
  const list = db.prepare('SELECT slug FROM lists WHERE id = ?').get(listId);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM lists WHERE id = ?').run(listId);
    purgeCompiledChannels(listId);
  });
  tx();
  if (list) removeListCache(list.slug);
  res.redirect('/lists');
});

router.get('/epgs', (req, res) => {
  const epgs = db.prepare(`
    SELECT e.*,
      (SELECT COUNT(*) FROM epg_channels WHERE epg_id = e.id) AS index_count,
      (SELECT COUNT(*) FROM epg_priorities WHERE epg_id = e.id) AS priority_count
    FROM epgs e ORDER BY e.id DESC
  `).all();
  res.render('epgs', { epgs });
});

router.post('/epgs', (req, res) => {
  const { name, slug, url, enabled } = req.body;
  const finalSlug = slugify(slug || name);
  db.prepare('INSERT INTO epgs (slug, name, url, enabled) VALUES (?, ?, ?, ?)')
    .run(finalSlug, name, url, enabled ? 1 : 0);
  res.redirect('/epgs');
});

router.post('/epgs/sync-all', (req, res) => {
  const result = jobs.enqueueServerJob({
    type: 'sync-epgs',
    label: res.locals.t('jobs.syncAllEpgs'),
    run: ({ signal, reporter }) => syncAllEpgs(reporter, signal),
  });
  return jobResponse(req, res, result, '/epgs');
});

router.get('/epgs/:id/edit', (req, res) => {
  const epg = db.prepare('SELECT * FROM epgs WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!epg) return res.status(404).send(res.locals.t('errors.epgNotFound'));
  res.render('epg_edit', { epg, saved: req.query.saved === '1', error: null });
});

router.post('/epgs/:id', (req, res) => {
  const t = res.locals.t;
  const epgId = parseInt(req.params.id, 10);
  const epg = db.prepare('SELECT * FROM epgs WHERE id = ?').get(epgId);
  if (!epg) return res.status(404).send(t('errors.epgNotFound'));

  const { name, slug, url, enabled } = req.body;
  const renderError = (message) => res.status(400).render('epg_edit', {
    epg: { ...epg, name: name || epg.name, slug: slug || epg.slug, url: url || epg.url, enabled: enabled ? 1 : 0 },
    saved: false, error: message,
  });

  if (!name || !name.trim()) return renderError(t('epgEdit.nameRequired'));
  if (!url || !url.trim()) return renderError(t('epgEdit.urlRequired'));

  const finalSlug = slugify(slug || name);
  if (!finalSlug) return renderError(t('epgEdit.slugRequired'));

  const oldSlug = epg.slug;
  let newCachedFile = epg.cached_file;
  if (oldSlug !== finalSlug) {
    const oldFile = path.join(config.epgCacheDir, `${oldSlug}.xml`);
    const newFile = path.join(config.epgCacheDir, `${finalSlug}.xml`);
    if (fs.existsSync(oldFile)) {
      try {
        fs.renameSync(oldFile, newFile);
        if (epg.cached_file === oldFile) newCachedFile = newFile;
      } catch (err) {
        logger.error({ err, oldFile, newFile }, 'epg cache rename failed');
      }
    }
  }

  try {
    db.prepare('UPDATE epgs SET name = ?, slug = ?, url = ?, enabled = ?, cached_file = ? WHERE id = ?')
      .run(name.trim(), finalSlug, url.trim(), enabled ? 1 : 0, newCachedFile, epgId);
  } catch (err) {
    return renderError(err.message);
  }

  res.redirect(`/epgs/${epgId}/edit?saved=1`);
});

router.post('/epgs/:id/delete', (req, res) => {
  const epgId = parseInt(req.params.id, 10);
  const epg = db.prepare('SELECT slug, cached_file FROM epgs WHERE id = ?').get(epgId);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM epg_channels WHERE epg_id = ?').run(epgId);
    db.prepare('DELETE FROM epgs WHERE id = ?').run(epgId);
    db.prepare('UPDATE lists SET epg_id = NULL WHERE epg_id = ?').run(epgId);
  });
  tx();
  if (epg) {
    const candidates = [
      path.join(config.epgCacheDir, `${epg.slug}.xml`),
      epg.cached_file,
    ].filter(Boolean);
    for (const file of candidates) {
      try { if (fs.existsSync(file)) fs.unlinkSync(file); }
      catch (err) { logger.error({ err, file }, 'epg cache cleanup failed'); }
    }
  }
  res.redirect('/epgs');
});

router.post('/epgs/:id/toggle', (req, res) => {
  db.prepare('UPDATE epgs SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  res.redirect('/epgs');
});

router.post('/epgs/:id/sync', (req, res) => {
  const epgId = parseInt(req.params.id, 10);
  const epg = db.prepare('SELECT name FROM epgs WHERE id = ?').get(epgId);
  const result = enqueueResourceJob({
    type: `sync-epg:${epgId}`,
    label: res.locals.t('jobs.syncEpg', { name: epg ? epg.name : `#${epgId}` }),
    current: epg ? epg.name : `epg:${epgId}`,
    runOne: (onStep, signal) => syncEpg(epgId, onStep, signal),
  });
  return jobResponse(req, res, result, '/epgs');
});

function parsePrioritiesPayload(raw, t) {
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(t('errors.invalidPrioritiesJson')); }
  if (!Array.isArray(parsed)) throw new Error(t('errors.prioritiesMustBeArray'));
  return parsed.map((p, pi) => {
    const tvgId = String(p.tvg_id == null ? '' : p.tvg_id).trim();
    if (!tvgId) throw new Error(t('errors.priorityTvgIdRequired', { n: pi + 1 }));
    const combinator = String(p.combinator || 'AND').toUpperCase();
    if (!COMBINATORS_SET.has(combinator)) throw new Error(`Priority ${pi + 1}: invalid combinator`);
    const displayName = p.display_name != null ? String(p.display_name).trim() : '';
    const rules = Array.isArray(p.rules) ? p.rules : [];
    if (rules.length === 0) throw new Error(t('errors.priorityRequiresRules', { n: pi + 1 }));
    const cleanRules = parseRulesArray(rules, `Priority ${pi + 1} rule`);
    return { tvg_id: tvgId, display_name: displayName || null, combinator, rules: cleanRules };
  });
}

function loadEpgPriorities(epgId) {
  const rows = db.prepare(`
    SELECT id, tvg_id, display_name, combinator, position
    FROM epg_priorities
    WHERE epg_id = ?
    ORDER BY position, id
  `).all(epgId);
  if (rows.length === 0) return [];
  const ph = rows.map(() => '?').join(',');
  const ruleRows = db.prepare(`
    SELECT priority_id, field, operator, value, position
    FROM epg_priority_rules
    WHERE priority_id IN (${ph})
    ORDER BY position, id
  `).all(...rows.map(r => r.id));
  const rulesByPri = new Map();
  for (const r of ruleRows) {
    if (!rulesByPri.has(r.priority_id)) rulesByPri.set(r.priority_id, []);
    rulesByPri.get(r.priority_id).push({ field: r.field, operator: r.operator, value: r.value });
  }
  return rows.map(r => ({
    id: r.id,
    tvg_id: r.tvg_id,
    display_name: r.display_name || '',
    combinator: r.combinator,
    rules: rulesByPri.get(r.id) || [],
  }));
}

router.get('/epgs/:id/priorities', (req, res) => {
  const epgId = parseInt(req.params.id, 10);
  const epg = db.prepare('SELECT * FROM epgs WHERE id = ?').get(epgId);
  if (!epg) return res.status(404).send(res.locals.t('epgPriorities.epgNotFound'));
  const priorities = loadEpgPriorities(epgId);
  const channelCount = db.prepare('SELECT COUNT(*) AS c FROM epg_channels WHERE epg_id = ?').get(epgId).c;
  res.render('epg_priorities', {
    epg, priorities, channelCount,
    FIELDS, OPERATORS, COMBINATORS,
    saved: req.query.saved === '1',
    error: null,
  });
});

router.get('/epgs/:id/priorities/channels.json', (req, res) => {
  const epgId = parseInt(req.params.id, 10);
  const q = (req.query.q || '').trim();
  const params = [epgId];
  let where = 'epg_id = ?';
  if (q) {
    where += ' AND (tvg_id LIKE ? OR display_name LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like);
  }
  const rows = db.prepare(`
    SELECT tvg_id, MIN(display_name) AS display_name
    FROM epg_channels
    WHERE ${where}
    GROUP BY tvg_id
    ORDER BY tvg_id
    LIMIT 50
  `).all(...params);
  res.json(rows);
});

router.post('/epgs/:id/priorities', (req, res) => {
  const t = res.locals.t;
  const epgId = parseInt(req.params.id, 10);
  const epg = db.prepare('SELECT * FROM epgs WHERE id = ?').get(epgId);
  if (!epg) return res.status(404).send(t('epgPriorities.epgNotFound'));
  const { priorities_json } = req.body;

  const renderError = (message, parsed) => {
    const channelCount = db.prepare('SELECT COUNT(*) AS c FROM epg_channels WHERE epg_id = ?').get(epgId).c;
    res.status(400).render('epg_priorities', {
      epg,
      priorities: Array.isArray(parsed) ? parsed.map((p, i) => ({ id: -i - 1, ...p })) : loadEpgPriorities(epgId),
      channelCount,
      FIELDS, OPERATORS, COMBINATORS,
      saved: false,
      error: message,
    });
  };

  let priorities;
  try { priorities = parsePrioritiesPayload(priorities_json, t); } catch (err) {
    let parsed = null;
    try { parsed = JSON.parse(priorities_json); } catch { /* noop */ }
    return renderError(err.message, parsed);
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM epg_priority_rules
      WHERE priority_id IN (SELECT id FROM epg_priorities WHERE epg_id = ?)`).run(epgId);
    db.prepare('DELETE FROM epg_priorities WHERE epg_id = ?').run(epgId);
    const priIns = db.prepare(`INSERT INTO epg_priorities
      (epg_id, tvg_id, display_name, combinator, position) VALUES (?, ?, ?, ?, ?)`);
    const ruleIns = db.prepare(`INSERT INTO epg_priority_rules
      (priority_id, field, operator, value, position) VALUES (?, ?, ?, ?, ?)`);
    priorities.forEach((p, pi) => {
      const info = priIns.run(epgId, p.tvg_id, p.display_name, p.combinator, pi);
      p.rules.forEach((r, ri) => ruleIns.run(info.lastInsertRowid, r.field, r.operator, r.value, ri));
    });
  });
  try { tx(); } catch (err) { return renderError(err.message); }
  res.redirect(`/epgs/${epgId}/priorities?saved=1`);
});

function parseImageRulesPayload(raw, t) {
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(t('errors.invalidFiltersJson')); }
  if (!Array.isArray(parsed)) throw new Error(t('errors.filtersMustBeArray'));
  return parseRulesArray(parsed, 'Filter');
}

function buildImagesWhere(q, filter) {
  const params = [];
  let where = "tvg_logo IS NOT NULL AND tvg_logo != ''";
  if (q) {
    where += ' AND (tvg_logo LIKE ? OR display_name LIKE ? OR tvg_name LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (filter === 'broken') {
    where += ' AND tvg_logo IN (SELECT url FROM broken_images WHERE broken = 1)';
  }
  return { where, params };
}

router.get('/images', (req, res) => {
  const { PER_PAGE, page, q } = paginate(req, 60);
  const filter = req.query.filter === 'broken' ? 'broken' : 'all';

  const overrides = db.prepare(`
    SELECT i.*,
      (SELECT COUNT(*) FROM image_override_rules WHERE image_id = i.id) AS rule_count,
      (SELECT broken FROM broken_images WHERE url = i.target_url) AS target_broken
    FROM image_overrides i
    ORDER BY i.id DESC
  `).all();

  const brokenRows = db.prepare("SELECT url, broken FROM broken_images").all();
  const brokenSet = new Set(brokenRows.filter(r => r.broken).map(r => r.url));
  const checkedSet = new Set(brokenRows.map(r => r.url));

  const { where, params } = buildImagesWhere(q, filter);
  const total = db.prepare(`
    SELECT COUNT(*) AS c FROM (SELECT tvg_logo FROM channels WHERE ${where} GROUP BY tvg_logo)
  `).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(total / PER_PAGE));
  const currentPage = Math.min(page, totalPages);
  const offset = (currentPage - 1) * PER_PAGE;
  const extracted = db.prepare(`
    SELECT tvg_logo, COUNT(*) AS uses, MIN(display_name) AS sample_name
    FROM channels
    WHERE ${where}
    GROUP BY tvg_logo
    ORDER BY uses DESC, tvg_logo
    LIMIT ? OFFSET ?
  `).all(...params, PER_PAGE, offset);

  const overriddenSet = new Set(
    db.prepare("SELECT DISTINCT source_url FROM image_overrides WHERE source_url IS NOT NULL AND source_url != ''")
      .all().map(r => r.source_url)
  );

  const brokenTotal = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT tvg_logo FROM channels
      WHERE tvg_logo IS NOT NULL AND tvg_logo != ''
        AND tvg_logo IN (SELECT url FROM broken_images WHERE broken = 1)
      GROUP BY tvg_logo
    )
  `).get().c;

  res.render('images', {
    overrides, extracted, overriddenSet, brokenSet, checkedSet,
    q, filter, brokenTotal,
    page: currentPage, totalPages, total, perPage: PER_PAGE,
  });
});

router.get('/images/check/all.json', (req, res) => {
  const rows = db.prepare(`
    SELECT url FROM (
      SELECT tvg_logo AS url FROM channels WHERE tvg_logo IS NOT NULL AND tvg_logo != ''
      UNION
      SELECT target_url AS url FROM image_overrides WHERE target_url IS NOT NULL AND target_url != ''
      UNION
      SELECT source_url AS url FROM image_overrides WHERE source_url IS NOT NULL AND source_url != ''
    ) ORDER BY url
  `).all();
  res.json({ urls: rows.map(r => r.url) });
});

router.post('/images/check', (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: res.locals.t('errors.urlRequired') });
  const broken = parseBroken(req.body.broken);
  markBrokenUrl('broken_images', url, broken);
  res.json({ ok: true, url, broken });
});

router.get('/images/new', (req, res) => {
  const sourceUrl = req.query.source_url || '';
  res.render('image_edit', {
    image: { id: null, name: '', source_url: sourceUrl, target_url: '', enabled: 1 },
    rules: [],
    FIELDS, OPERATORS,
    saved: false, error: null,
  });
});

router.post('/images', (req, res) => {
  const t = res.locals.t;
  const { name, source_url, target_url, enabled, rules_json } = req.body;
  const renderEdit = (error, parsedRules) => res.status(400).render('image_edit', {
    image: { id: null, name, source_url, target_url, enabled: enabled ? 1 : 0 },
    rules: parsedRules || [],
    FIELDS, OPERATORS,
    saved: false, error,
  });
  if (!target_url || !target_url.trim()) return renderEdit(t('imageEdit.targetRequired'));
  let rules;
  try { rules = parseImageRulesPayload(rules_json, t); } catch (err) { return renderEdit(err.message); }
  const tx = db.transaction(() => {
    const info = db.prepare('INSERT INTO image_overrides (name, source_url, target_url, enabled) VALUES (?, ?, ?, ?)')
      .run(name ? name.trim() : null, source_url ? source_url.trim() : null, target_url.trim(), enabled ? 1 : 0);
    const ins = db.prepare('INSERT INTO image_override_rules (image_id, field, operator, value, position) VALUES (?, ?, ?, ?, ?)');
    rules.forEach((r, i) => ins.run(info.lastInsertRowid, r.field, r.operator, r.value, i));
    return info.lastInsertRowid;
  });
  const id = tx();
  res.redirect(`/images/${id}/edit?saved=1`);
});

router.get('/images/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const image = db.prepare('SELECT * FROM image_overrides WHERE id = ?').get(id);
  if (!image) return res.status(404).send(res.locals.t('imageEdit.notFound'));
  const rules = db.prepare('SELECT * FROM image_override_rules WHERE image_id = ? ORDER BY position, id').all(id);
  res.render('image_edit', {
    image, rules,
    FIELDS, OPERATORS,
    saved: req.query.saved === '1', error: null,
  });
});

router.post('/images/:id', (req, res) => {
  const t = res.locals.t;
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM image_overrides WHERE id = ?').get(id);
  if (!existing) return res.status(404).send(t('imageEdit.notFound'));
  const { name, source_url, target_url, enabled, rules_json } = req.body;
  const renderError = (message) => {
    let rules = [];
    try { rules = parseImageRulesPayload(rules_json, t).map((r, i) => ({ ...r, id: -i - 1, position: i })); } catch { /* ignore */ }
    res.status(400).render('image_edit', {
      image: { id, name, source_url, target_url, enabled: enabled ? 1 : 0 },
      rules,
      FIELDS, OPERATORS,
      saved: false, error: message,
    });
  };
  if (!target_url || !target_url.trim()) return renderError(t('imageEdit.targetRequired'));
  let rules;
  try { rules = parseImageRulesPayload(rules_json, t); } catch (err) { return renderError(err.message); }
  const tx = db.transaction(() => {
    db.prepare('UPDATE image_overrides SET name = ?, source_url = ?, target_url = ?, enabled = ? WHERE id = ?')
      .run(name ? name.trim() : null, source_url ? source_url.trim() : null, target_url.trim(), enabled ? 1 : 0, id);
    db.prepare('DELETE FROM image_override_rules WHERE image_id = ?').run(id);
    const ins = db.prepare('INSERT INTO image_override_rules (image_id, field, operator, value, position) VALUES (?, ?, ?, ?, ?)');
    rules.forEach((r, i) => ins.run(id, r.field, r.operator, r.value, i));
  });
  try { tx(); } catch (err) { return renderError(err.message); }
  res.redirect(`/images/${id}/edit?saved=1`);
});

router.post('/images/:id/toggle', (req, res) => {
  db.prepare('UPDATE image_overrides SET enabled = 1 - enabled WHERE id = ?').run(req.params.id);
  res.redirect('/images');
});

router.post('/images/:id/delete', (req, res) => {
  db.prepare('DELETE FROM image_overrides WHERE id = ?').run(req.params.id);
  res.redirect('/images');
});

module.exports = router;
