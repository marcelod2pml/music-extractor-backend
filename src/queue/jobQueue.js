const EventEmitter = require('events');
const { createJob } = require('../models/jobModel');

class JobQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this.concurrency = options.concurrency || 2;
    this.jobs = new Map(); // jobId -> Job
    this.queue = []; // Array of jobIds
    this.activeWorkers = 0;
  }

  /**
   * Enfileira ou recupera job ativo para o mesmo videoId
   */
  enqueue(videoId) {
    const cleanId = String(videoId).trim();

    // 1. Deduplicação: se já existe job ativo (queued ou processing) para este videoId, reutiliza
    for (const job of this.jobs.values()) {
      if (job.videoId === cleanId && (job.status === 'queued' || job.status === 'processing')) {
        return { job, isExisting: true };
      }
    }

    // 2. Se já existe um job concluído com sucesso recentemente, pode ser retornado
    for (const job of this.jobs.values()) {
      if (job.videoId === cleanId && job.status === 'completed') {
        return { job, isExisting: true };
      }
    }

    // 3. Cria novo job
    const job = createJob(cleanId);
    this.jobs.set(job.id, job);
    this.queue.push(job.id);

    this.emit('job:enqueued', job);
    this.processNext();

    return { job, isExisting: false };
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  updateJob(jobId, updates = {}) {
    const job = this.jobs.get(jobId);
    if (!job) return null;

    Object.assign(job, updates, { updatedAt: new Date().toISOString() });
    this.emit('job:updated', job);
    return job;
  }

  getNextPendingJob() {
    if (this.queue.length === 0) return null;
    if (this.activeWorkers >= this.concurrency) return null;

    const jobId = this.queue.shift();
    const job = this.jobs.get(jobId);

    if (!job || job.status !== 'queued') {
      return this.getNextPendingJob();
    }

    return job;
  }

  processNext() {
    if (this.activeWorkers >= this.concurrency) return;
    const nextJob = this.getNextPendingJob();
    if (!nextJob) return;

    this.activeWorkers++;
    this.emit('job:process', nextJob);
  }

  workerFinished(jobId) {
    this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    this.processNext();
  }

  /**
   * Limpeza de jobs antigos na memória (mais de 24 horas)
   */
  pruneOldJobs() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, job] of this.jobs.entries()) {
      if (new Date(job.updatedAt).getTime() < cutoff) {
        this.jobs.delete(id);
      }
    }
  }
}

// Instância singleton da fila de jobs
const jobQueue = new JobQueue({ concurrency: 2 });

module.exports = {
  jobQueue,
  JobQueue,
};
