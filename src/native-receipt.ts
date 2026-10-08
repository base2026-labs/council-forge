import { z } from 'zod';
const Identity = z
  .string()
  .regex(/^[a-zA-Z0-9._:/-]{1,256}$/)
  .nullable();
const Count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
// Explicit allowlist: no prompt, output, raw host error or credential fields.
export const NativeReceiptSchema = z.object({
  state: z.enum(['requested', 'acknowledged', 'in_flight', 'terminal', 'unknown']),
  boundary: z.enum([
    'invocation_requested',
    'thread_requested',
    'thread_acknowledged',
    'turn_requested',
    'turn_dispatched',
    'turn_acknowledged',
    'awaiting_completion',
    'turn_started',
    'usage_reported',
    'turn_completed',
    'connection_lost',
    'rejected',
    'recovery',
  ]),
  requestedModel: Identity,
  requestedEffort: Identity,
  actualModel: Identity,
  actualEffort: Identity,
  threadStartRequestId: Count,
  turnStartRequestId: Count,
  threadId: Identity,
  turnId: Identity,
  inferenceDispatched: z.boolean(),
  outcome: z.enum(['unknown', 'completed', 'failed', 'interrupted', 'not_dispatched']),
  errorCode: z
    .string()
    .regex(/^[A-Z0-9_]{1,80}$/)
    .nullable(),
  usage: z.object({ inputTokens: Count, outputTokens: Count, costUsd: z.null() }),
  usageEvidence: z.object({
    source: z.literal('thread/tokenUsage/updated:last').nullable(),
    cachedInputTokens: Count,
    reasoningOutputTokens: Count,
    totalTokens: Count,
  }),
});
export type NativeReceipt = z.infer<typeof NativeReceiptSchema>;
export const nativeIdentity = (value: unknown): string | null =>
  typeof value === 'string' && /^[a-zA-Z0-9._:/-]{1,256}$/.test(value) ? value : null;
export const nativeCount = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export const NativeContextSchema = z.object({
  agent: Identity.optional(),
  phase: z.enum(['propose', 'critique', 'verify', 'chair']).optional(),
  provider: Identity.optional(),
  billing: z.literal('subscription').optional(),
});
