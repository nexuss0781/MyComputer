import { z } from 'zod';

export const jobKinds = ['exec', 'train', 'transform', 'bench'] as const;
export type JobKind = (typeof jobKinds)[number];

export const jobStates = ['queued', 'claimed', 'running', 'done', 'failed'] as const;
export type JobState = (typeof jobStates)[number];

export const dispatchSchema = z.object({
  sessionId: z.string().uuid(),
  kind: z.enum(jobKinds),
  payload: z.record(z.unknown()).default({}),
  timeoutMs: z.number().int().positive().optional(),
});

export type DispatchInput = z.infer<typeof dispatchSchema>;

export interface JobRow {
  jobId: string;
  sessionId: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  state: JobState;
  claimedBy: string | null;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}
