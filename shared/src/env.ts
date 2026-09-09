import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  SUPABASE_SECRET_KEY: z.string().min(1).optional(),
  DATABASE_URL: z.string().min(1).optional(),
  BRIDGE_URL: z.string().url().optional(),
  BRIDGE_TOKEN: z.string().min(1).optional(),
  BRIDGE_CHANNEL_ID: z.string().min(1).optional(),
  DEFAULT_SESSION_NAME: z.string().min(1).default('my-computer'),
  MAX_CHUNK_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024 * 1024)
    .default(8 * 1024 * 1024),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment: ${parsed.error.message}`);
  }
  cached = parsed.data;
  return cached;
}

export function resetEnvCache(): void {
  cached = undefined;
}

export type OperationStatus = 'pending' | 'running' | 'ok' | 'error';

export interface ApiErrorShape {
  code: string;
  message: string;
}
