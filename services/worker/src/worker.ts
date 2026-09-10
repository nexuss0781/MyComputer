import { BridgeClient, loadEnv } from '@mycomputer/shared';
import { createClient } from '@supabase/supabase-js';
import { Executor, SupabaseExecStore } from '../../../app/core/executor.js';
import { SupabaseJobStore } from '../../../app/core/job-store.js';
import { SupabaseJournalStore } from '../../../app/core/journal-supabase.js';
import { Oplog } from '../../../app/core/oplog.js';

const HEARTBEAT_INTERVAL_MS = 120_000; // 2 min
const WORKER_MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000; // 6 hours
const JOB_POLL_LIMIT = 5;

interface WorkerContext {
  jobStore: SupabaseJobStore;
  executor: Executor;
  journal: Oplog;
  bridge: BridgeClient;
  workerId: string;
}

function buildContext(): WorkerContext {
  const env = loadEnv();
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL + service key required');
  if (!env.BRIDGE_URL || !env.BRIDGE_TOKEN || !env.BRIDGE_CHANNEL_ID) {
    throw new Error('BRIDGE_URL + BRIDGE_TOKEN + BRIDGE_CHANNEL_ID required');
  }

  const db = createClient(url, key);
  const jobStore = new SupabaseJobStore(db);
  const journal = new Oplog(new SupabaseJournalStore(db));
  const executor = new Executor(new SupabaseExecStore(db), {
    maxTimeoutMs: WORKER_MAX_TIMEOUT_MS,
  });
  const bridge = new BridgeClient({
    baseUrl: env.BRIDGE_URL,
    token: env.BRIDGE_TOKEN,
    channelId: env.BRIDGE_CHANNEL_ID,
  });
  const workerId = `gh-${process.env.GITHUB_RUN_ID ?? process.pid}`;

  return { jobStore, executor, journal, bridge, workerId };
}

async function processJob(
  ctx: WorkerContext,
  job: Awaited<ReturnType<SupabaseJobStore['claimNext']>>,
): Promise<void> {
  if (!job) return;

  const command = (job.payload.command as string | undefined) ?? '';
  const timeoutMs = (job.payload.timeoutMs as number | undefined) ?? WORKER_MAX_TIMEOUT_MS;

  await ctx.jobStore.markState(job.jobId, 'running' as never, ctx.workerId);

  const heartbeat = setInterval(() => {
    ctx.jobStore.heartbeat(job.jobId).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const exec = await ctx.executor.run(job.sessionId, { command, timeoutMs });

    await ctx.journal.record(
      'job',
      job.sessionId,
      { jobId: job.jobId, kind: job.kind, execId: exec.execId },
      {
        jobId: job.jobId,
        execId: exec.execId,
        exitCode: exec.exitCode,
        durationMs: exec.durationMs,
        stdout: exec.stdout?.slice(0, 4096),
        stderr: exec.stderr?.slice(0, 4096),
      },
      exec.exitCode === 0 ? 'ok' : 'error',
      exec.durationMs,
    );

    const resultBytes = new TextEncoder().encode(
      JSON.stringify(
        {
          jobId: job.jobId,
          kind: job.kind,
          command,
          exitCode: exec.exitCode,
          durationMs: exec.durationMs,
          stdout: exec.stdout?.slice(0, 8192),
          stderr: exec.stderr?.slice(0, 8192),
        },
        null,
        2,
      ),
    );

    let resultRef: Record<string, unknown> = {};
    try {
      const uploadResult = await ctx.bridge.upload(resultBytes, {
        sessionId: job.sessionId,
        path: `/jobs/${job.jobId}/result.json`,
        seq: 0,
        checksum: '',
        size: resultBytes.byteLength,
      });
      resultRef = { telegramMsgId: uploadResult.msgId, fileId: uploadResult.fileId };
    } catch {
      // Bridge upload is best-effort; journal + job completion still valid
    }

    await ctx.jobStore.markState(job.jobId, 'done', ctx.workerId, {
      exitCode: exec.exitCode,
      execId: exec.execId,
      durationMs: exec.durationMs,
      ...resultRef,
    });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await ctx.journal.recordError(
      'job',
      job.sessionId,
      { jobId: job.jobId, kind: job.kind },
      { code: 'job_failed', message: errMsg },
    );
    await ctx.jobStore.markState(job.jobId, 'failed', ctx.workerId, {
      error: errMsg,
    });
  } finally {
    clearInterval(heartbeat);
  }
}

export async function run(): Promise<number> {
  const ctx = buildContext();
  let processed = 0;

  const requeued = await ctx.jobStore.requeueStale();
  if (requeued > 0) {
    console.log(`[worker] requeued ${requeued} stale jobs`);
  }

  for (let i = 0; i < JOB_POLL_LIMIT; i++) {
    const job = await ctx.jobStore.claimNext(ctx.workerId);
    if (!job) break;
    console.log(`[worker] claimed job ${job.jobId} (${job.kind})`);
    await processJob(ctx, job);
    processed += 1;
  }

  return processed;
}

export async function main(): Promise<void> {
  const processed = await run();
  console.log(`[worker] done — processed ${processed} job(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('[worker] fatal:', error);
    process.exit(1);
  });
}
