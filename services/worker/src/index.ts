import { loadEnv } from '@mycomputer/shared';

export function main(): void {
  const env = loadEnv();
  console.log(`my-computer worker ready (session=${env.DEFAULT_SESSION_NAME})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
