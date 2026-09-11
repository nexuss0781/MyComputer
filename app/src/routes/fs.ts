import {
  ComputerError,
  appendSchema,
  checksumSchema,
  copySchema,
  deleteSchema,
  listSchema,
  mkdirSchema,
  moveSchema,
  readSchema,
  statSchema,
  writeSchema,
} from '@nexuss0781/shared';
import type { Context, Hono } from 'hono';
import type { ZodType, z } from 'zod';
import type { FsEngine } from '../../core/fs-engine.js';

export type EngineProvider = () => FsEngine | null;

type HttpStatus = 400 | 404 | 409 | 500;

export function errorResponse(error: unknown): {
  ok: boolean;
  error: { code: string; message: string };
} {
  if (error instanceof ComputerError) {
    return {
      ok: false,
      error: { code: error.code, message: error.message },
    };
  }
  if (error instanceof Error) {
    return { ok: false, error: { code: 'internal', message: error.message } };
  }
  return { ok: false, error: { code: 'internal', message: 'unknown error' } };
}

export function errorStatus(error: unknown): HttpStatus {
  return error instanceof ComputerError ? (error.status as HttpStatus) : 500;
}

type ZodBodySchema = ZodType<unknown>;

export function fsRoutes(engine: EngineProvider, app: Hono): void {
  const route =
    <T extends ZodBodySchema>(schema: T) =>
    (action: (input: z.infer<T>, engine: FsEngine) => Promise<unknown>) =>
    async (c: Context) => {
      const live = engine();
      if (!live) {
        return c.json(
          {
            ok: false,
            error: { code: 'engine_not_configured', message: 'fs engine not configured' },
          },
          503,
        );
      }
      const body: unknown = await c.req.json().catch(() => null);
      const parsed = schema.safeParse(body);
      if (!parsed.success) {
        return c.json(
          {
            ok: false,
            error: {
              code: 'invalid_input',
              message: parsed.error.issues[0]?.message ?? 'invalid payload',
            },
          },
          400,
        );
      }
      try {
        const result = await action(parsed.data as z.infer<T>, live);
        return c.json({ ok: true, data: result });
      } catch (error) {
        return c.json(errorResponse(error), errorStatus(error));
      }
    };

  app.post(
    '/api/fs/write',
    route(writeSchema)((input, e) =>
      e.write(input.sessionId, input.path, toBytes(input.content), input.mime),
    ),
  );
  app.post(
    '/api/fs/read',
    route(readSchema)((input, e) =>
      e.read(input.sessionId, input.path, input.offset ?? 0, input.limit),
    ),
  );
  app.post(
    '/api/fs/append',
    route(appendSchema)((input, e) =>
      e.append(input.sessionId, input.path, toBytes(input.content)),
    ),
  );
  app.post(
    '/api/fs/mkdir',
    route(mkdirSchema)((input, e) =>
      e.mkdir(input.sessionId, input.path, input.recursive ?? false),
    ),
  );
  app.post(
    '/api/fs/list',
    route(listSchema)((input, e) => e.list(input.sessionId, input.path)),
  );
  app.post(
    '/api/fs/move',
    route(moveSchema)((input, e) => e.move(input.sessionId, input.from, input.to)),
  );
  app.post(
    '/api/fs/copy',
    route(copySchema)((input, e) => e.copy(input.sessionId, input.from, input.to)),
  );
  app.post(
    '/api/fs/delete',
    route(deleteSchema)((input, e) =>
      e.remove(input.sessionId, input.path, input.recursive ?? false),
    ),
  );
  app.post(
    '/api/fs/stat',
    route(statSchema)((input, e) => e.stat(input.sessionId, input.path)),
  );
  app.post(
    '/api/fs/checksum',
    route(checksumSchema)((input, e) => e.checksum(input.sessionId, input.path)),
  );
}

function toBytes(content: string): Uint8Array {
  return new Uint8Array(Buffer.from(content, 'base64'));
}
