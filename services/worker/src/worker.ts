import { BridgeClient, loadEnv } from '@mycomputer/shared';
import { createClient } from '@supabase/supabase-js';
import { BatchBackend } from '../../../app/core/batch-backend.js';
import { runMultiGbBench } from '../../../app/core/bench-multigb.js';
import { ColdBackend } from '../../../app/core/cold-backend.js';
import { Executor, SupabaseExecStore } from '../../../app/core/executor.js';
import { FsEngine } from '../../../app/core/fs-engine.js';
import { SupabaseJobStore } from '../../../app/core/job-store.js';
import { SupabaseJournalStore } from '../../../app/core/journal-supabase.js';
import { Oplog } from '../../../app/core/oplog.js';
import { SupabaseBackend } from '../../../app/core/supabase-backend.js';
import { SupabaseSyncStateStore, SupabaseSyncTarget } from '../../../app/core/sync-supabase.js';
import { TelegramSink } from '../../../app/core/sync-telegram.js';
import { SyncWriter } from '../../../app/core/sync.js';

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

  await ctx.jobStore.markState(job.jobId, 'running' as never, ctx.workerId);

  const heartbeat = setInterval(() => {
    ctx.jobStore.heartbeat(job.jobId).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  try {
    if (job.kind === 'bench') {
      await processBenchJob(ctx, job);
    } else {
      await processExecJob(ctx, job);
    }
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

async function processExecJob(
  ctx: WorkerContext,
  job: Awaited<ReturnType<SupabaseJobStore['claimNext']>>,
): Promise<void> {
  if (!job) return;

  const command = (job.payload.command as string | undefined) ?? '';
  const timeoutMs = (job.payload.timeoutMs as number | undefined) ?? WORKER_MAX_TIMEOUT_MS;

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
}

async function processBenchJob(
  ctx: WorkerContext,
  job: Awaited<ReturnType<SupabaseJobStore['claimNext']>>,
): Promise<void> {
  if (!job) return;

  const env = loadEnv();
  const url = env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL is required');
  const key = env.SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_KEY ?? env.SUPABASE_SECRET_KEY;
  if (!key) throw new Error('SUPABASE service key is required');
  const db = createClient(url, key);
  const syncState = new SupabaseSyncStateStore(db);
  const target = new SupabaseSyncTarget(db, syncState);
  const writer = new SyncWriter({ target, state: syncState });
  const bridgeUrl = env.BRIDGE_URL;
  const bridgeToken = env.BRIDGE_TOKEN;
  const bridgeChannelId = env.BRIDGE_CHANNEL_ID;
  if (!bridgeUrl || !bridgeToken || !bridgeChannelId)
    throw new Error('BRIDGE_URL, BRIDGE_TOKEN, BRIDGE_CHANNEL_ID are required');
  const bridge = new BridgeClient({
    baseUrl: bridgeUrl,
    token: bridgeToken,
    channelId: bridgeChannelId,
  });
  const sink = new TelegramSink(bridge, target);
  const durableBackend = new SupabaseBackend(db);
  const coldBackend = new ColdBackend(durableBackend, sink);
  const engine = new FsEngine(
    new BatchBackend(coldBackend, writer),
    new Oplog(new SupabaseJournalStore(db)),
  );

  const totalSizeBytes = (job.payload.totalSizeBytes as number) ?? 2 * 1024 * 1024 * 1024;
  const segmentBytes = (job.payload.segmentBytes as number) ?? 8 * 1024 * 1024;
  const sessionId = (job.payload.sessionId as string) ?? job.sessionId;
  const filePath = (job.payload.path as string) ?? '/multigb.bin';

  const t0 = Date.now();
  const benchResult = await runMultiGbBench({
    engine,
    writer,
    sink,
    totalSizeBytes,
    segmentBytes,
    sessionId,
    path: filePath,
    prunePath: async (sid: string, p: string) => {
      const { error } = await db
        .from('blocks')
        .update({ data: null })
        .eq('session_id', sid)
        .eq('path', p);
      if (error) throw new Error(`prune failed: ${error.message}`);
    },
  });
  const durationMs = Date.now() - t0;

  await ctx.journal.record(
    'bench',
    job.sessionId,
    { jobId: job.jobId, kind: 'bench', totalSizeBytes, segmentBytes },
    { jobId: job.jobId, ...benchResult },
    benchResult.sha256Verified ? 'ok' : 'error',
    durationMs,
  );

  const resultBytes = new TextEncoder().encode(
    JSON.stringify({ jobId: job.jobId, kind: 'bench', ...benchResult }, null, 2),
  );

  let resultRef: Record<string, unknown> = {};
  try {
    const uploadResult = await ctx.bridge.upload(resultBytes, {
      sessionId: job.sessionId,
      path: `/jobs/${job.jobId}/bench-result.json`,
      seq: 0,
      checksum: '',
      size: resultBytes.byteLength,
    });
    resultRef = { telegramMsgId: uploadResult.msgId, fileId: uploadResult.fileId };
  } catch {
    // Best-effort
  }

  await ctx.jobStore.markState(job.jobId, 'done', ctx.workerId, {
    exitCode: benchResult.sha256Verified ? 0 : 1,
    durationMs,
    sha256Verified: benchResult.sha256Verified,
    sizeBytes: benchResult.sizeBytes,
    blocks: benchResult.blocks,
    hotWriteMs: benchResult.hotWriteMs,
    flushMs: benchResult.flushMs,
    drainMs: benchResult.drainMs,
    coldRestoreMs: benchResult.coldRestoreMs,
    ...resultRef,
  });
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
