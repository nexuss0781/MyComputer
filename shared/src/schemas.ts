import { z } from 'zod';

export const sessionIdSchema = z.string().uuid();
export const pathSchema = z.string().min(1).max(4096);

const basePathBody = z.object({
  sessionId: sessionIdSchema,
  path: pathSchema,
});

export const writeSchema = z.object({
  sessionId: sessionIdSchema,
  path: pathSchema,
  content: z.string(),
  mime: z.string().min(1).max(255).optional(),
});

export const readSchema = z.object({
  sessionId: sessionIdSchema,
  path: pathSchema,
  offset: z.number().int().nonnegative().optional(),
  limit: z
    .number()
    .int()
    .positive()
    .max(1024 * 1024 * 1024)
    .optional(),
});

export const appendSchema = z.object({
  sessionId: sessionIdSchema,
  path: pathSchema,
  content: z.string(),
});

export const mkdirSchema = z.object({
  sessionId: sessionIdSchema,
  path: pathSchema,
  recursive: z.boolean().optional(),
});

export const listSchema = basePathBody;

export const moveSchema = z.object({
  sessionId: sessionIdSchema,
  from: pathSchema,
  to: pathSchema,
});

export const copySchema = moveSchema;

export const deleteSchema = z.object({
  sessionId: sessionIdSchema,
  path: pathSchema,
  recursive: z.boolean().optional(),
});

export const statSchema = basePathBody;
export const checksumSchema = basePathBody;

export const sessionCreateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  meta: z.record(z.unknown()).optional(),
});

export type WriteInput = z.infer<typeof writeSchema>;
export type ReadInput = z.infer<typeof readSchema>;
export type AppendInput = z.infer<typeof appendSchema>;
export type MkdirInput = z.infer<typeof mkdirSchema>;
export type MoveInput = z.infer<typeof moveSchema>;
export type DeleteInput = z.infer<typeof deleteSchema>;

export type InodeType = 'file' | 'dir';

export interface Inode {
  path: string;
  sessionId: string;
  type: InodeType;
  mode: number;
  size: number;
  mime: string | null;
  checksum: string | null;
  parent: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlockRef {
  seq: number;
  size: number;
  checksum: string;
}

export interface WriteResult {
  path: string;
  size: number;
  checksum: string;
  blocks: number;
}

export interface ReadResult {
  path: string;
  content: string;
  offset: number;
  bytes: number;
  checksum: string | null;
}

export interface SessionRow {
  id: string;
  name: string;
  createdAt: string;
  meta: Record<string, unknown>;
}
