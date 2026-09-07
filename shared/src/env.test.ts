import { describe, expect, it } from 'vitest';
import { envSchema, loadEnv, resetEnvCache } from './env.js';

describe('env loader', () => {
  it('applies defaults for optional vars and computed size limits', () => {
    resetEnvCache();
    const env = loadEnv({});
    expect(env.DEFAULT_SESSION_NAME).toBe('my-computer');
    expect(env.MAX_CHUNK_BYTES).toBe(8 * 1024 * 1024);
  });

  it('coerces MAX_CHUNK_BYTES from a string', () => {
    resetEnvCache();
    const env = loadEnv({ MAX_CHUNK_BYTES: '1048576' });
    expect(env.MAX_CHUNK_BYTES).toBe(1024 * 1024);
  });

  it('rejects oversized chunk sizes (above 2 GiB ceiling)', () => {
    resetEnvCache();
    const parsed = envSchema.safeParse({ MAX_CHUNK_BYTES: '2147483649' });
    expect(parsed.success).toBe(false);
  });

  it('accepts a full real-world config', () => {
    resetEnvCache();
    const env = loadEnv({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-role-key',
      BRIDGE_URL: 'https://bridge.example.com',
      BRIDGE_TOKEN: 'bridge-token',
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
    });
    expect(env.SUPABASE_URL).toBe('https://example.supabase.co');
  });
});
