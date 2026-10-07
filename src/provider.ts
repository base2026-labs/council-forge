import type { Agent, Evidence, Claim } from './schema.ts';
export type Phase = 'propose' | 'critique' | 'verify' | 'chair';
export interface Invocation {
  agent: Agent;
  phase: Phase;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  evidence: Evidence[];
  claims: Claim[];
}
export interface Completion {
  text: string;
  actualModel: string;
  requestId: string | null;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
}
export interface Provider {
  complete(input: Invocation): Promise<Completion>;
}
