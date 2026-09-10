import type { Hono } from 'hono';
import {
  type BenchReport,
  runFlushScaleBench,
  runHotReadBench,
  runMicroBench,
} from '../../core/bench.js';
import type { FsEngine } from '../../core/fs-engine.js';
import type { SelftestEnvironment } from '../../core/selftest.js';
import type { ColdSelftestFactory, PersistenceSelftestFactory } from '../runtime.js';
import { errorResponse, errorStatus } from './fs.js';

export interface BenchDeps {
  engine: () => FsEngine | null;
  environment: SelftestEnvironment;
  persistenceFactory: () => PersistenceSelftestFactory | null;
  coldFactory: () => ColdSelftestFactory | null;
}

export function benchRoutes(deps: BenchDeps, app: Hono): void {
  app.post('/api/sys/bench', async (c) => {
    try {
      const engine = deps.engine();
      if (!engine) {
        return c.json({ ok: false, error: 'engine unavailable' }, 400);
      }

      const body: Record<string, unknown> = await c.req.json().catch(() => ({}));
      const scopes = Array.isArray(body.scopes) ? (body.scopes as string[]) : ['micro'];

      const report: BenchReport = {
        environment: deps.environment,
        micro: null,
        hotread: null,
        flushScale: null,
        coldRestore: null,
        crashRecovery: null,
        corruptionDrill: null,
        timestamp: new Date().toISOString(),
      };

      if (scopes.includes('micro')) {
        report.micro = await runMicroBench(engine);
      }

      if (scopes.includes('hotread') || scopes.includes('all')) {
        const persistence = deps.persistenceFactory();
        if (persistence) {
          report.hotread = await runHotReadBench(
            persistence.engine,
            persistence.writer,
            deps.environment,
          );
        }
      }

      if (scopes.includes('flush') || scopes.includes('all')) {
        const persistence = deps.persistenceFactory();
        if (persistence) {
          const target = (
            persistence.writer as unknown as {
              deps: { target: import('../../core/sync.js').SyncTarget };
            }
          ).deps.target;
          report.flushScale = await runFlushScaleBench(persistence.writer, target);
        }
      }

      return c.json({ ok: true, data: report });
    } catch (error) {
      return c.json(errorResponse(error), errorStatus(error));
    }
  });
}
