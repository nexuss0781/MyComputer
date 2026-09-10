import { loadEnv } from '@mycomputer/shared';

export { main, run } from './worker.js';

export function legacy(): void {
  const env = loadEnv();
  console.log(`my-computer worker ready (session=${env.DEFAULT_SESSION_NAME})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  legacy();
}
