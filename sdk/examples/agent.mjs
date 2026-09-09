// Dogfood agent: drive a My-Computer session end-to-end with the SDK.
//
//   MY_COMPUTER_URL=https://nexuss-computer.vercel.app node build example
//
// Resolves a fresh session, writes a multi-chunk file, appends, execs a
// command, replays its log, lists, verifies checksums, and reports.

import { ComputerClient } from '../dist/index.js';
import { readAll, writeAll } from '../dist/fssio.js';

const baseUrl = (process.env.MY_COMPUTER_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
// 3 MiB raw → 4 MiB wire after base64 (4/3 inflation), proven safe against the
// Vercel serverless body cap (blocks observed at 4.375 MiB wire).
const CHUNK = 3 * 1024 * 1024;

async function main() {
  const client = new ComputerClient({ baseUrl, chunkSize: CHUNK });
  console.log(`my-computer at ${baseUrl}`);

  const session = await client.createSession({ name: 'sdk-dogfood' });
  const box = client.mount(session.id);
  console.log(`session ${session.id}`);

  const text = 'phase 6 live\n'.repeat(2000); // ~20 KiB
  const first = await box.write('/sdk/dogfood.txt', text, 'text/plain');
  console.log(`write  -> ${first.path} (${first.size} B, ${first.blocks} block)`);

  // append path: existing file gains bytes
  await box.write('/sdk/append.log', 'a1:');
  const afterAppend = await box.append('/sdk/append.log', 'a2:a3:a4');
  console.log(`append -> ${afterAppend.path} (${afterAppend.size} B => ${afterAppend.checksum})`);

  // multi-chunk blob: writeAll splits and reassembles byte-identical
  const content = new Uint8Array(CHUNK + 11).map((_, k) => (k * 31) % 256);
  const written = await writeAll(client, session.id, '/sdk/dogfood.bin', content, {
    chunkSize: CHUNK,
  });
  console.log(`blob   -> ${written.path} (${written.size} B, ${written.blocks} blocks)`);

  const readBack = await readAll(client, session.id, '/sdk/dogfood.bin');
  const identical = Buffer.from(readBack).equals(Buffer.from(content));
  console.log(`read   -> ${readBack.byteLength} B, byte-identical: ${identical}`);
  if (!identical) throw new Error('blob read-back mismatch');

  const execution = await box.exec('echo sdk-dogfood-ok && node --version');
  console.log(
    `exec  -> exit ${execution.exitCode}, ${execution.durationMs} ms, stdout: ${execution.stdout.trim()}`,
  );

  const replay = await box.execLog({ execId: execution.execId });
  console.log(`log   -> replay ${replay.execId} (${replay.stdout.split('\n').length} lines)`);

  const entries = await box.list('/sdk');
  for (const entry of entries) {
    const sum = entry.type === 'file' ? await box.checksum(entry.path) : null;
    console.log(`list  -> ${entry.type} ${entry.path} (${entry.size} B, sha256 ${sum?.checksum})`);
  }
  if (entries.length !== 3) throw new Error(`expected 3 entries, got ${entries.length}`);

  const stats = await box.stat('/sdk/dogfood.txt');
  console.log(
    'saved session id:',
    session.id,
    '| first file:',
    stats.path,
    stats.size,
    'B',
    stats.checksum,
  );
}

main().catch((error) => {
  console.error('dogfood failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
