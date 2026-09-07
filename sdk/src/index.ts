import type { ApiErrorShape } from '@mycomputer/shared';

export interface ClientConfig {
  baseUrl: string;
}

export class ComputerClient {
  readonly baseUrl: string;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
  }

  async ping(): Promise<{ ok: boolean }> {
    const res = await fetch(`${this.baseUrl}/api/sys/ping`);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as ApiErrorShape | null;
      throw new Error(`my-computer request failed: ${body?.code ?? res.status}`);
    }
    return res.json() as Promise<{ ok: boolean }>;
  }
}
