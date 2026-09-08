import { randomUUID } from 'node:crypto';
import type { OperationStatus } from '@mycomputer/shared';

export interface OplogRecord {
  opId: string;
  sessionId: string;
  opType: string;
  input: unknown;
  result: unknown;
  status: OperationStatus;
  durationMs: number;
  createdAt: string;
}

export interface JournalStore {
  insert(record: OplogRecord): Promise<void>;
  countForSession(sessionId: string): Promise<number>;
  allAfter(sessionId: string, after: Date): Promise<OplogRecord[]>;
}

export class MemoryJournalStore implements JournalStore {
  readonly records: OplogRecord[] = [];

  async insert(record: OplogRecord): Promise<void> {
    this.records.push(record);
  }

  async countForSession(sessionId: string): Promise<number> {
    return this.records.filter((r) => r.sessionId === sessionId).length;
  }

  async allAfter(sessionId: string, after: Date): Promise<OplogRecord[]> {
    return this.records.filter(
      (r) => r.sessionId === sessionId && new Date(r.createdAt).getTime() > after.getTime(),
    );
  }
}

export class Oplog {
  constructor(private readonly store: JournalStore) {}

  async record(
    opType: string,
    sessionId: string,
    input: unknown,
    result: unknown,
    status: OperationStatus = 'ok',
    durationMs = 0,
  ): Promise<OplogRecord> {
    const record: OplogRecord = {
      opId: randomUUID(),
      sessionId,
      opType,
      input,
      result,
      status,
      durationMs,
      createdAt: new Date().toISOString(),
    };
    await this.store.insert(record);
    return record;
  }

  async recordError(
    opType: string,
    sessionId: string,
    input: unknown,
    error: { code: string; message: string },
    durationMs = 0,
  ): Promise<OplogRecord> {
    return this.record(opType, sessionId, input, { error }, 'error', durationMs);
  }

  async journalCount(sessionId: string): Promise<number> {
    return this.store.countForSession(sessionId);
  }

  async allAfter(sessionId: string, after: Date): Promise<OplogRecord[]> {
    return this.store.allAfter(sessionId, after);
  }
}
