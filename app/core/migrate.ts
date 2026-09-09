import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations');

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

let ensured = false;
let ensuring: Promise<void> | null = null;
let ensuredError: Error | null = null;

export function migrationStatus(): { ensured: boolean; error: string | null } {
  return { ensured, error: ensuredError?.message ?? null };
}

export function ensureMigrated(): Promise<void> {
  if (ensured) return Promise.resolve();
  if (ensuring) return ensuring;
  ensuring = runMigrations();
  return ensuring;
}

async function runMigrations(): Promise<void> {
  const connectionUrl =
    process.env.DATABASE_URL ??
    process.env.POSTGRES_URL_NON_POOLING ??
    process.env.POSTGRES_PRISMA_URL;
  if (!connectionUrl) {
    throw new Error('no DATABASE_URL/POSTGRES_URL_NON_POOLING available for migrations');
  }

  const forceNoVerify = /supabase\.(co|com)/.test(connectionUrl);
  const url = forceNoVerify
    ? connectionUrl
        .replace(/sslmode=[^&$]+/, 'sslmode=no-verify')
        .replace(/(?<!sslmode=no-verify)([?!])$/, '$1sslmode=no-verify')
    : connectionUrl;

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );

    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const { rows } = await client.query('SELECT name, checksum FROM _migrations');
    const applied = new Map(rows.map((r) => [String(r.name), String(r.checksum)]));

    for (const file of files) {
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      const checksum = sha256(sql);
      const prior = applied.get(file);
      if (prior !== undefined) {
        if (prior !== checksum)
          throw new Error(`migration ${file} already applied with a different checksum`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', [
          file,
          checksum,
        ]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }

    ensured = true;
  } catch (error) {
    ensuredError = error instanceof Error ? error : new Error(String(error));
    throw error;
  } finally {
    await client.end();
  }
}
