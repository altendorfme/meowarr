const logger = require('./logger');

const CLIENT_HEARTBEAT_TIMEOUT_MS = parseInt(process.env.JOB_CLIENT_HEARTBEAT_MS || '15000', 10);
const HISTORY_LIMIT = 10;

let current = null;
let seq = 0;
const history = [];

function snapshotJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    label: job.label,
    status: job.status,
    cancellable: !!job.cancellable,
    progress: {
      done: job.done || 0,
      total: job.total || 0,
      step: job.step || null,
      current: job.current || null,
    },
    counters: job.counters || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    summary: job.summary || null,
    kind: job.kind,
  };
}

function snapshot() {
  return {
    current: snapshotJob(current),
    history: history.slice(0, HISTORY_LIMIT).map(snapshotJob),
  };
}

function pushHistory(job) {
  history.unshift(job);
  if (history.length > HISTORY_LIMIT) history.length = HISTORY_LIMIT;
}

function makeReporter(job) {
  return {
    setProgress(done, total, step) {
      job.done = typeof done === 'number' ? done : job.done;
      job.total = typeof total === 'number' ? total : job.total;
      if (step !== undefined) job.step = step || null;
    },
    setCurrent(name, step) {
      job.current = name || null;
      if (step !== undefined) job.step = step || null;
    },
    setSub(done, total, step) {
      job.done = typeof done === 'number' ? done : job.done;
      job.total = typeof total === 'number' ? total : job.total;
      if (step !== undefined) job.step = step || null;
    },
    setCounters(counters) {
      job.counters = { ...(job.counters || {}), ...(counters || {}) };
    },
    setSummary(summary) {
      job.summary = summary || null;
    },
  };
}

function isBusy() {
  return !!(current && (current.status === 'running' || current.status === 'cancelling'));
}

function enqueueServerJob({ type, label, cancellable = true, run }) {
  if (isBusy()) return { ok: false, reason: 'busy', current: snapshotJob(current) };
  const id = ++seq;
  const controller = new AbortController();
  const job = {
    id,
    type,
    kind: 'server',
    label: label || type,
    status: 'running',
    cancellable: !!cancellable,
    controller,
    done: 0,
    total: 0,
    step: null,
    current: null,
    counters: null,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    summary: null,
  };
  current = job;
  const reporter = makeReporter(job);
  Promise.resolve()
    .then(() => run({ signal: controller.signal, reporter, job }))
    .then((summary) => {
      if (summary !== undefined) job.summary = summary;
      job.status = controller.signal.aborted ? 'cancelled' : 'done';
    })
    .catch((err) => {
      const aborted = controller.signal.aborted || (err && /abort/i.test(err.message || ''));
      job.status = aborted ? 'cancelled' : 'failed';
      job.error = err && err.message ? err.message : String(err);
      if (!aborted) logger.error({ err, jobId: job.id, type: job.type }, 'job failed');
    })
    .finally(() => {
      job.finishedAt = Date.now();
      pushHistory(job);
      if (current === job) current = null;
    });
  return { ok: true, job: snapshotJob(job) };
}

function startClientJob({ type, label, cancellable = true, total = 0 }) {
  if (isBusy()) return { ok: false, reason: 'busy', current: snapshotJob(current) };
  const id = ++seq;
  const job = {
    id,
    type,
    kind: 'client',
    label: label || type,
    status: 'running',
    cancellable: !!cancellable,
    controller: null,
    done: 0,
    total: total || 0,
    step: null,
    current: null,
    counters: null,
    startedAt: Date.now(),
    lastHeartbeat: Date.now(),
    finishedAt: null,
    error: null,
    summary: null,
    cancelRequested: false,
  };
  current = job;
  return { ok: true, job: snapshotJob(job) };
}

function heartbeatClientJob(id, payload) {
  if (!current || current.id !== id || current.kind !== 'client') {
    return { ok: false, reason: 'not-current' };
  }
  current.lastHeartbeat = Date.now();
  if (payload) {
    if (typeof payload.done === 'number') current.done = payload.done;
    if (typeof payload.total === 'number') current.total = payload.total;
    if (payload.current !== undefined) current.current = payload.current || null;
    if (payload.step !== undefined) current.step = payload.step || null;
    if (payload.counters) current.counters = { ...(current.counters || {}), ...payload.counters };
  }
  return {
    ok: true,
    cancelRequested: !!current.cancelRequested,
    job: snapshotJob(current),
  };
}

function finishClientJob(id, payload) {
  if (!current || current.id !== id || current.kind !== 'client') {
    return { ok: false, reason: 'not-current' };
  }
  const job = current;
  if (payload) {
    if (typeof payload.done === 'number') job.done = payload.done;
    if (typeof payload.total === 'number') job.total = payload.total;
    if (payload.summary) job.summary = payload.summary;
    if (payload.error) job.error = payload.error;
    if (payload.counters) job.counters = { ...(job.counters || {}), ...payload.counters };
  }
  if (payload && payload.error) job.status = 'failed';
  else if (payload && payload.cancelled) job.status = 'cancelled';
  else job.status = 'done';
  job.finishedAt = Date.now();
  pushHistory(job);
  if (current === job) current = null;
  return { ok: true, job: snapshotJob(job) };
}

function cancel(id) {
  if (!current || current.id !== id) return { ok: false, reason: 'not-current' };
  if (!current.cancellable) return { ok: false, reason: 'not-cancellable' };
  current.status = 'cancelling';
  if (current.kind === 'server' && current.controller) {
    try { current.controller.abort(new Error('cancelled by user')); } catch (_) { /* noop */ }
  } else {
    current.cancelRequested = true;
  }
  return { ok: true, job: snapshotJob(current) };
}

function reapClientJob() {
  if (!current || current.kind !== 'client') return;
  if (Date.now() - (current.lastHeartbeat || current.startedAt) > CLIENT_HEARTBEAT_TIMEOUT_MS) {
    current.status = 'failed';
    current.error = 'client heartbeat timeout';
    current.finishedAt = Date.now();
    pushHistory(current);
    current = null;
  }
}

setInterval(reapClientJob, 5000).unref();

function dropCurrent(reason) {
  if (!current) return;
  current.status = 'failed';
  current.error = reason || 'dropped';
  current.finishedAt = Date.now();
  pushHistory(current);
  current = null;
}

module.exports = {
  snapshot,
  snapshotCurrent: () => snapshotJob(current),
  isBusy,
  enqueueServerJob,
  startClientJob,
  heartbeatClientJob,
  finishClientJob,
  cancel,
  dropCurrent,
};
