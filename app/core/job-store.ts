import type { JobKind, JobRow, JobState } from '@mycomputer/shared';
import type { SupabaseClient } from '@supabase/supabase-js';

const MAX_ATTEMPTS = 3;
const CLAIM_TIMEOUT_MS = 600_000; // 10 min

export interface JobStore {
  insert(sessionId: string, kind: JobKind, payload: Record<string, unknown>): Promise<JobRow>;
  claimNext(workerId: string): Promise<JobRow | null>;
  markState(
    jobId: string,
    state: 'done' | 'failed',
    workerId: string,
    result?: Record<string, unknown>,
  ): Promise<void>;
  heartbeat(jobId: string): Promise<void>;
  requeueStale(): Promise<number>;
  get(jobId: string): Promise<JobRow | null>;
  list(sessionId: string, offset?: number, limit?: number): Promise<JobRow[]>;
}

interface JobRowRaw {
  job_id: string;
  session_id: string;
  kind: string;
  payload: Record<string, unknown>;
  state: string;
  claimed_by: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

function mapRow(row: JobRowRaw): JobRow {
  return {
    jobId: row.job_id,
    sessionId: row.session_id,
    kind: row.kind as JobKind,
    payload: row.payload ?? {},
    state: row.state as JobState,
    claimedBy: row.claimed_by,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class MemoryJobStore implements JobStore {
  private readonly rows = new Map<string, JobRow>();
  private seq = 0;

  async insert(
    sessionId: string,
    kind: JobKind,
    payload: Record<string, unknown>,
  ): Promise<JobRow> {
    const now = new Date().toISOString();
    const job: JobRow = {
      jobId: `j-${++this.seq}`,
      sessionId,
      kind,
      payload,
      state: 'queued',
      claimedBy: null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(job.jobId, job);
    return job;
  }

  async claimNext(workerId: string): Promise<JobRow | null> {
    const candidates = [...this.rows.values()]
      .filter((j) => j.state === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const job = candidates[0];
    if (!job) return null;

    job.state = 'claimed';
    job.claimedBy = workerId;
    job.updatedAt = new Date().toISOString();
    return { ...job };
  }

  async markState(
    jobId: string,
    state: 'done' | 'failed',
    workerId: string,
    result?: Record<string, unknown>,
  ): Promise<void> {
    const job = this.rows.get(jobId);
    if (!job || job.claimedBy !== workerId) return;
    job.state = state;
    if (result) job.payload = { ...job.payload, ...result };
    job.updatedAt = new Date().toISOString();
  }

  async heartbeat(jobId: string): Promise<void> {
    const job = this.rows.get(jobId);
    if (job) job.updatedAt = new Date().toISOString();
  }

  async requeueStale(): Promise<number> {
    const cutoff = Date.now() - CLAIM_TIMEOUT_MS;
    let count = 0;
    for (const job of this.rows.values()) {
      if (job.state !== 'claimed' && job.state !== 'running') continue;
      if (new Date(job.updatedAt).getTime() > cutoff) continue;
      job.attempts += 1;
      if (job.attempts >= MAX_ATTEMPTS) {
        job.state = 'failed';
      } else {
        job.state = 'queued';
        job.claimedBy = null;
      }
      job.updatedAt = new Date().toISOString();
      count += 1;
    }
    return count;
  }

  async get(jobId: string): Promise<JobRow | null> {
    const job = this.rows.get(jobId);
    return job ? { ...job } : null;
  }

  async list(sessionId: string, offset = 0, limit = 100): Promise<JobRow[]> {
    return [...this.rows.values()]
      .filter((j) => j.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(offset, offset + limit)
      .map((j) => ({ ...j }));
  }
}

export class SupabaseJobStore implements JobStore {
  constructor(private readonly db: SupabaseClient) {}

  async insert(
    sessionId: string,
    kind: JobKind,
    payload: Record<string, unknown>,
  ): Promise<JobRow> {
    const { data, error } = await this.db
      .from('jobs')
      .insert({ session_id: sessionId, kind, payload })
      .select()
      .single();
    if (error) throw new Error(`jobs insert failed: ${error.message}`);
    return mapRow(data as JobRowRaw);
  }

  async claimNext(workerId: string): Promise<JobRow | null> {
    const { data, error } = await this.db.rpc('claim_job', { p_worker_id: workerId });
    if (error) throw new Error(`claim_job failed: ${error.message}`);
    const row = Array.isArray(data) ? data[0] : data;
    return row ? mapRow(row as JobRowRaw) : null;
  }

  async markState(
    jobId: string,
    state: 'done' | 'failed',
    workerId: string,
    result?: Record<string, unknown>,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      state,
      updated_at: new Date().toISOString(),
    };
    if (result) {
      // Fetch current payload and merge result
      const { data: current } = await this.db
        .from('jobs')
        .select('payload')
        .eq('job_id', jobId)
        .single();
      update.payload = {
        ...((current as { payload?: Record<string, unknown> })?.payload ?? {}),
        result,
      };
    }
    const { error } = await this.db
      .from('jobs')
      .update(update)
      .eq('job_id', jobId)
      .eq('claimed_by', workerId);
    if (error) throw new Error(`jobs markState failed: ${error.message}`);
  }

  async heartbeat(jobId: string): Promise<void> {
    const { error } = await this.db
      .from('jobs')
      .update({ updated_at: new Date().toISOString() })
      .eq('job_id', jobId);
    if (error) throw new Error(`jobs heartbeat failed: ${error.message}`);
  }

  async requeueStale(): Promise<number> {
    const { data, error } = await this.db.rpc('requeue_stale_jobs', {
      p_ttl_ms: CLAIM_TIMEOUT_MS,
      p_max_attempts: MAX_ATTEMPTS,
    });
    if (error) throw new Error(`requeue_stale_jobs failed: ${error.message}`);
    return (data as number) ?? 0;
  }

  async get(jobId: string): Promise<JobRow | null> {
    const { data, error } = await this.db
      .from('jobs')
      .select('*')
      .eq('job_id', jobId)
      .maybeSingle();
    if (error) throw new Error(`jobs get failed: ${error.message}`);
    return data ? mapRow(data as JobRowRaw) : null;
  }

  async list(sessionId: string, offset = 0, limit = 100): Promise<JobRow[]> {
    const { data, error } = await this.db
      .from('jobs')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw new Error(`jobs list failed: ${error.message}`);
    return (data as JobRowRaw[]).map(mapRow);
  }
}
