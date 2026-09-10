import { describe, expect, it } from 'vitest';
import { MemoryJobStore } from './job-store.js';

describe('MemoryJobStore', () => {
  it('inserts a queued job', async () => {
    const store = new MemoryJobStore();
    const job = await store.insert('s1', 'exec', { command: 'echo hi' });
    expect(job.state).toBe('queued');
    expect(job.kind).toBe('exec');
    expect(job.sessionId).toBe('s1');
    expect(job.payload.command).toBe('echo hi');
    expect(job.attempts).toBe(0);
  });

  it('claims exactly one queued job', async () => {
    const store = new MemoryJobStore();
    await store.insert('s1', 'exec', { command: 'a' });
    await store.insert('s1', 'exec', { command: 'b' });

    const claimed = await store.claimNext('worker-1');
    expect(claimed).not.toBeNull();
    expect(claimed?.state).toBe('claimed');
    expect(claimed?.claimedBy).toBe('worker-1');

    const remaining = await store.claimNext('worker-2');
    expect(remaining).not.toBeNull();
    expect(remaining?.jobId).not.toBe(claimed?.jobId);

    const empty = await store.claimNext('worker-3');
    expect(empty).toBeNull();
  });

  it('claims in FIFO order', async () => {
    const store = new MemoryJobStore();
    const j1 = await store.insert('s1', 'exec', { command: 'first' });
    const j2 = await store.insert('s1', 'exec', { command: 'second' });
    const j3 = await store.insert('s1', 'exec', { command: 'third' });

    const c1 = await store.claimNext('w');
    expect(c1?.jobId).toBe(j1.jobId);

    const c2 = await store.claimNext('w');
    expect(c2?.jobId).toBe(j2.jobId);

    const c3 = await store.claimNext('w');
    expect(c3?.jobId).toBe(j3.jobId);
  });

  it('concurrent claims do not double-claim', async () => {
    const store = new MemoryJobStore();
    await store.insert('s1', 'exec', { command: 'only' });

    const c1 = await store.claimNext('w1');
    const c2 = await store.claimNext('w2');
    expect(c1).not.toBeNull();
    expect(c2).toBeNull();
  });

  it('markState done with result merges into payload', async () => {
    const store = new MemoryJobStore();
    await store.insert('s1', 'exec', { command: 'echo' });
    const claimed = await store.claimNext('w');
    expect(claimed).not.toBeNull();

    await store.markState(claimed?.jobId ?? '', 'done', 'w', { exitCode: 0, execId: 'e1' });
    const done = await store.get(claimed?.jobId ?? '');
    expect(done?.state).toBe('done');
    expect(done?.payload.exitCode).toBe(0);
    expect(done?.payload.execId).toBe('e1');
    expect(done?.payload.command).toBe('echo');
  });

  it('markState only succeeds for the claiming worker', async () => {
    const store = new MemoryJobStore();
    await store.insert('s1', 'exec', {});
    const claimed = await store.claimNext('w1');
    await store.markState(claimed?.jobId ?? '', 'done', 'w2', {});
    const jobAfter = await store.get(claimed?.jobId ?? '');
    expect(jobAfter?.state).toBe('claimed');
  });

  it('heartbeat bumps updatedAt', async () => {
    const store = new MemoryJobStore();
    await store.insert('s1', 'exec', {});
    const claimed = await store.claimNext('w');
    const before = claimed?.updatedAt;
    await new Promise((r) => setTimeout(r, 10));
    await store.heartbeat(claimed?.jobId ?? '');
    const after = await store.get(claimed?.jobId ?? '');
    expect(after?.updatedAt).not.toBe(before);
  });

  it('requeueStale re-queues old claimed jobs', async () => {
    const store = new MemoryJobStore();
    const job = await store.insert('s1', 'exec', {});
    await store.claimNext('w');

    // Backdate the internal row's updatedAt (get() returns a copy)
    const internal = (store as unknown as { rows: Map<string, { updatedAt: string }> }).rows;
    const row = internal.get(job.jobId);
    if (row) row.updatedAt = new Date(Date.now() - 999_999).toISOString();

    const requeued = await store.requeueStale();
    expect(requeued).toBe(1);
    const after = await store.get(job.jobId);
    expect(after?.state).toBe('queued');
    expect(after?.claimedBy).toBeNull();
    expect(after?.attempts).toBe(1);
  });

  it('requeueStale dead-letters after max attempts', async () => {
    const store = new MemoryJobStore();
    const job = await store.insert('s1', 'exec', {});
    const internal = (store as unknown as { rows: Map<string, { updatedAt: string }> }).rows;

    for (let i = 0; i < 3; i++) {
      await store.claimNext('w');
      const row = internal.get(job.jobId);
      if (row) row.updatedAt = new Date(Date.now() - 999_999).toISOString();
      await store.requeueStale();
    }

    const final = await store.get(job.jobId);
    expect(final?.state).toBe('failed');
    expect(final?.attempts).toBe(3);
  });

  it('list returns jobs scoped to session', async () => {
    const store = new MemoryJobStore();
    await store.insert('s1', 'exec', {});
    await store.insert('s2', 'train', {});
    await store.insert('s1', 'bench', {});

    const s1Jobs = await store.list('s1');
    expect(s1Jobs).toHaveLength(2);
    const s2Jobs = await store.list('s2');
    expect(s2Jobs).toHaveLength(1);
  });
});
