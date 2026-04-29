const cron = require('node-cron');
const config = require('./config');
const db = require('./db');
const { syncAllSources, syncAllEpgs } = require('./sync');
const { regenerateAllListCaches } = require('./filters');
const jobs = require('./jobs');
const logger = require('./logger');

let dailyTask = null;
let cleanupTask = null;

function cleanupOrphanBrokenRecords() {
  const urlPurge = db.prepare(`
    DELETE FROM broken_urls
    WHERE url NOT IN (SELECT url FROM compiled_channels WHERE url IS NOT NULL)
      AND url NOT IN (SELECT url FROM channels WHERE url IS NOT NULL)
  `);
  const imgPurge = db.prepare(`
    DELETE FROM broken_images
    WHERE url NOT IN (SELECT tvg_logo FROM channels WHERE tvg_logo IS NOT NULL AND tvg_logo != '')
      AND url NOT IN (SELECT target_url FROM image_overrides WHERE target_url IS NOT NULL)
      AND url NOT IN (SELECT source_url FROM image_overrides WHERE source_url IS NOT NULL)
  `);
  const tx = db.transaction(() => {
    const u = urlPurge.run();
    const i = imgPurge.run();
    return { urls: u.changes, images: i.changes };
  });
  return tx();
}

function start() {
  if (!cron.validate(config.cronDaily)) {
    logger.error({ expr: config.cronDaily }, 'invalid cron expression for daily routine');
    return;
  }
  dailyTask = cron.schedule(config.cronDaily, () => {
    if (jobs.isBusy()) {
      logger.warn('daily routine skipped: another job is running');
      return;
    }
    const result = jobs.enqueueServerJob({
      type: 'daily-routine',
      label: 'Daily routine',
      run: async ({ signal, reporter }) => {
        logger.info('starting daily routine');
        reporter.setCurrent('EPGs', 'fetch');
        const e = await syncAllEpgs(reporter, signal);
        logger.info({ count: e.length }, 'epgs synced');
        reporter.setCurrent('Sources', 'fetch');
        const s = await syncAllSources(reporter, signal);
        logger.info({ count: s.length }, 'sources synced');
        reporter.setCurrent('Lists', 'filter');
        const c = await regenerateAllListCaches(reporter, signal);
        logger.info({ count: c.length }, 'lists regenerated');
        return { epgs: e.length, sources: s.length, lists: c.length };
      },
    });
    if (!result.ok) logger.warn('daily routine could not start');
  });

  if (cron.validate(config.cronCleanup)) {
    cleanupTask = cron.schedule(config.cronCleanup, () => {
      try {
        const r = cleanupOrphanBrokenRecords();
        logger.info(r, 'cleanup orphan records');
      } catch (err) {
        logger.error({ err }, 'cleanup failed');
      }
    });
  }

  logger.info({ daily: config.cronDaily, cleanup: config.cronCleanup }, 'cron scheduled');
}

function stop() {
  if (dailyTask) { try { dailyTask.stop(); } catch (_) { /* noop */ } dailyTask = null; }
  if (cleanupTask) { try { cleanupTask.stop(); } catch (_) { /* noop */ } cleanupTask = null; }
}

module.exports = { start, stop, cleanupOrphanBrokenRecords };
