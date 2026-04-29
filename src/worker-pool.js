const path = require('path');
const os = require('os');
const { Worker } = require('worker_threads');
const logger = require('./logger');

const WORKER_FILE = path.join(__dirname, 'workers', 'resolve-worker.js');
const POOL_SIZE = Math.max(1, parseInt(
  process.env.RESOLVE_WORKERS || String(Math.max(1, Math.min(4, (os.cpus() || []).length - 1))),
  10
));

const workers = [];
const idle = [];
const queue = [];
const jobs = new Map();
let jobSeq = 0;
let started = false;
let stopping = false;

function spawnWorker() {
  const w = new Worker(WORKER_FILE);
  const slot = { worker: w, job: null };
  w.on('message', (msg) => {
    const job = jobs.get(msg.jobId);
    if (!job) return;
    if (msg.type === 'progress') {
      if (job.onProgress) {
        try { job.onProgress(msg.done, msg.total); } catch (_) { /* noop */ }
      }
    } else if (msg.type === 'done') {
      jobs.delete(msg.jobId);
      slot.job = null;
      detachAbort(job);
      job.resolve(msg.channels);
      releaseSlot(slot);
    } else if (msg.type === 'error') {
      jobs.delete(msg.jobId);
      slot.job = null;
      detachAbort(job);
      const err = new Error(msg.error || 'worker error');
      if (msg.stack) err.stack = msg.stack;
      job.reject(err);
      releaseSlot(slot);
    }
  });
  w.on('error', (err) => {
    logger.error({ err }, 'resolve worker crashed');
    if (slot.job) {
      const job = jobs.get(slot.job);
      if (job) {
        jobs.delete(slot.job);
        detachAbort(job);
        job.reject(err);
      }
      slot.job = null;
    }
    const idx = workers.indexOf(slot);
    if (idx >= 0) workers.splice(idx, 1);
    const idleIdx = idle.indexOf(slot);
    if (idleIdx >= 0) idle.splice(idleIdx, 1);
    if (!stopping) {
      const replacement = spawnWorker();
      releaseSlot(replacement);
    }
  });
  w.on('exit', (code) => {
    if (stopping) return;
    if (code !== 0) logger.warn({ code }, 'resolve worker exited');
  });
  workers.push(slot);
  return slot;
}

function ensureStarted() {
  if (started || stopping) return;
  started = true;
  for (let i = 0; i < POOL_SIZE; i++) {
    const slot = spawnWorker();
    idle.push(slot);
  }
  logger.info({ workers: POOL_SIZE }, 'resolve worker pool started');
}

function releaseSlot(slot) {
  if (stopping) return;
  if (queue.length > 0) {
    const next = queue.shift();
    dispatch(slot, next);
  } else {
    if (!idle.includes(slot) && workers.includes(slot)) idle.push(slot);
  }
}

function dispatch(slot, job) {
  slot.job = job.id;
  job.slot = slot;
  jobs.set(job.id, job);
  slot.worker.postMessage({ type: 'resolve', jobId: job.id, ...job.payload });
}

function detachAbort(job) {
  if (job && job.signal && job.onAbort) {
    try { job.signal.removeEventListener('abort', job.onAbort); } catch (_) { /* noop */ }
    job.onAbort = null;
  }
}

function attachAbort(job) {
  if (!job.signal) return;
  if (job.signal.aborted) {
    abortJob(job);
    return;
  }
  job.onAbort = () => abortJob(job);
  job.signal.addEventListener('abort', job.onAbort, { once: true });
}

function abortJob(job) {
  if (!jobs.has(job.id)) return;
  jobs.delete(job.id);
  detachAbort(job);
  const idx = queue.indexOf(job);
  if (idx >= 0) {
    queue.splice(idx, 1);
    job.reject(new Error('aborted'));
    return;
  }
  const slot = job.slot;
  if (slot && slot.job === job.id) {
    slot.job = null;
    const wIdx = workers.indexOf(slot);
    if (wIdx >= 0) workers.splice(wIdx, 1);
    const iIdx = idle.indexOf(slot);
    if (iIdx >= 0) idle.splice(iIdx, 1);
    slot.worker.terminate().catch(() => null);
    if (!stopping) {
      const replacement = spawnWorker();
      releaseSlot(replacement);
    }
  }
  job.reject(new Error('aborted'));
}

function runResolve(payload, onProgress, signal) {
  ensureStarted();
  return new Promise((resolve, reject) => {
    const id = ++jobSeq;
    const job = { id, payload, onProgress, resolve, reject, signal: signal || null, onAbort: null, slot: null };
    if (signal && signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    attachAbort(job);
    const slot = idle.shift();
    if (slot) dispatch(slot, job);
    else queue.push(job);
  });
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const job of jobs.values()) {
    job.reject(new Error('worker pool shutting down'));
  }
  jobs.clear();
  queue.length = 0;
  await Promise.all(workers.map(s => s.worker.terminate().catch(() => null)));
  workers.length = 0;
  idle.length = 0;
}

module.exports = { runResolve, shutdown, POOL_SIZE };
