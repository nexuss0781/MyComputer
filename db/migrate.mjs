import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const url =
  process.env.DATABASE_URL ??
  process.env.POSTGRES_URL_NON_POOLING ??
  process.env.POSTGRES_PRISMA_URL;

if (!url) {
  throw new Error('DATABASE_URL (or POSTGRES_URL_NON_POOLING) is required');
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const forceNoVerify = /supabase\.(co|com)/.test(url);
const connectionUrl = forceNoVerify
  ? url
      .replace(/sslmode=[^&$]+/, 'sslmode=no-verify')
      .replace(/(?<!sslmode=no-verify)([?!])$/, '$1sslmode=no-verify')
  : url;

const client = new pg.Client({ connectionString: connectionUrl });
await client.connect();

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const sum = sha256(sql);

    const { rows } = await client.query('SELECT checksum FROM _migrations WHERE name = $1', [file]);
    if (rows[0]) {
      if (rows[0].checksum !== sum) {
        throw new Error(`${file} has changed since it was applied (checksum mismatch)`);
      }
      continue;
    }

    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name, checksum) VALUES ($1, $2)', [file, sum]);
      await client.query('COMMIT');
      console.log(`applied ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  console.log('migrations up to date');
} finally {
  await client.end();
}
