import { open, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  getIssuanceRequestDigest,
  parseIssuanceRequest,
} from '../../../dist/domain/src/index.js';
import {
  check,
  privateDirectory,
  readJson,
  readOwned,
  writeNew,
  replaceJson,
  sha256,
} from './io.mjs';

/** One process owns this small demo journal. A crash requires explicit lock review. */
export class JobStore {
  constructor(path) {
    this.path = path;
    this.jobs = new Map();
    this.tail = Promise.resolve();
    this.updates = new Map();
  }
  async open() {
    await privateDirectory(this.path);
    this.lock = await open(join(this.path, '.service.lock'), 'wx', 0o600);
    await this.lock.writeFile(
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
    );
    await this.lock.sync();
    const names = await readdir(this.path);
    const ids = names.filter((name) => /^[0-9a-f]{64}$/.test(name));
    check(ids.length <= 10, 'service_unavailable', 503);
    for (const id of ids) {
      const job = await readJson(join(this.path, id, 'job.json'), 512 * 1024);
      check(
        job.jobId === id && /^[0-9a-f]{64}$/.test(job.documentId),
        'service_unavailable',
        503,
      );
      const request = parseIssuanceRequest(job.request);
      check(
        getIssuanceRequestDigest(request) === job.requestDigest &&
          job.requestDigest === `0x${id}` &&
          !this.forDocument(job.documentId),
        'service_unavailable',
        503,
      );
      if (job.journalHash) {
        const events = (
          await readOwned(join(this.path, id, 'events.jsonl'), 1024 * 1024)
        )
          .toString('utf8')
          .trim()
          .split('\n');
        let previous = '0'.repeat(64);
        for (const line of events) {
          const { hash, ...event } = JSON.parse(line);
          check(
            event.previousHash === previous &&
              sha256(JSON.stringify(event)) === hash,
            'service_unavailable',
            503,
          );
          previous = hash;
        }
        check(previous === job.journalHash, 'service_unavailable', 503);
      }
      this.jobs.set(id, job);
      if (
        ![
          'awaiting_signature',
          'blocked',
          'ready_to_mint',
          'attention_required',
        ].includes(job.status)
      ) {
        await this.update(job, {
          status: 'attention_required',
          detailCode:
            job.status === 'reserving'
              ? 'reservation_uncertain'
              : 'proof_request_uncertain',
        });
      }
    }
    return this;
  }
  serial(action) {
    const work = this.tail.then(action);
    this.tail = work.catch(() => {});
    return work;
  }
  directory(id) {
    check(/^[0-9a-f]{64}$/.test(id));
    return join(this.path, id);
  }
  get(id) {
    const job = this.jobs.get(id);
    check(job, 'job_not_found', 404);
    return job;
  }
  forDocument(id) {
    return [...this.jobs.values()].find((job) => job.documentId === id);
  }
  async create(job) {
    check(
      this.jobs.size < 10 && !this.forDocument(job.documentId),
      'job_conflict',
      409,
    );
    await privateDirectory(this.directory(job.jobId));
    await writeNew(join(this.directory(job.jobId), 'job.json'), job);
    this.jobs.set(job.jobId, job);
    return job;
  }
  update(job, patch) {
    const work = (this.updates.get(job.jobId) ?? Promise.resolve()).then(() =>
      this.append(job, patch),
    );
    this.updates.set(
      job.jobId,
      work.catch(() => {}),
    );
    return work;
  }
  async append(job, patch) {
    const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
    const previousHash = job.journalHash ?? '0'.repeat(64);
    const event = {
      previousHash,
      status: next.status,
      detailCode: next.detailCode ?? null,
      updatedAt: next.updatedAt,
    };
    next.journalHash = sha256(JSON.stringify(event));
    const file = await open(
      join(this.directory(job.jobId), 'events.jsonl'),
      'a',
      0o600,
    );
    try {
      await file.writeFile(
        JSON.stringify({ ...event, hash: next.journalHash }) + '\n',
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await replaceJson(join(this.directory(job.jobId), 'job.json'), next);
    Object.assign(job, next);
    return job;
  }
  async close() {
    await Promise.all(this.updates.values());
    if (this.lock) {
      await this.lock.close();
      await unlink(join(this.path, '.service.lock'));
      this.lock = undefined;
    }
  }
}
