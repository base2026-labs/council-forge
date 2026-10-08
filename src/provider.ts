import type { Agent, Evidence, Claim } from './schema.ts';
import { CouncilError } from './policy.ts';
import type { NativeReceipt } from './native-receipt.ts';
export type Phase = 'propose' | 'critique' | 'verify' | 'chair';
export interface Invocation {
  agent: Agent;
  phase: Phase;
  prompt: string;
  maxOutputTokens: number;
  signal: AbortSignal;
  evidence: Evidence[];
  claims: Claim[];
  outputLanguage?: string;
  onNativeReceipt?: (receipt: NativeReceipt) => void;
}
export interface Completion {
  text: string;
  actualModel: string;
  requestId: string | null;
  actualEffort?: string | null;
  capabilityReceipt?: unknown;
  nativeReceipt?: NativeReceipt;
  usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null };
}
export interface Provider {
  complete(input: Invocation): Promise<Completion>;
}
export interface ProviderReceipt {
  nativeReceipt?: NativeReceipt;
  actualModel: string | null;
  requestId: string | null;
  usage: Completion['usage'];
}
// Extract accounting independently of completion validity. Only bounded identities
// and individually valid numeric fields cross this boundary; never raw response text.
export function reportedReceipt(raw: unknown): ProviderReceipt {
  const out = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const usage =
    out.usage && typeof out.usage === 'object' ? (out.usage as Record<string, unknown>) : {};
  const identity = (v: unknown) =>
    typeof v === 'string' && /^[a-zA-Z0-9._:/-]{1,256}$/.test(v) ? v : null;
  const tokens = (v: unknown) =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
  const cost = usage.cost;
  return {
    actualModel: identity(out.model),
    requestId: identity(out.id),
    usage: {
      inputTokens: tokens(usage.prompt_tokens),
      outputTokens: tokens(usage.completion_tokens),
      costUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : null,
    },
  };
}
export class ProviderResponseError extends CouncilError {
  constructor(
    error: unknown,
    public readonly receipt: ProviderReceipt,
  ) {
    super(
      error instanceof CouncilError ? error.code : 'PROVIDER_OR_SCHEMA_ERROR',
      'Provider response was rejected. Only sanitized identity and usage are retained.',
    );
  }
}
export function validateResponse<T>(raw: unknown, validate: () => T): T {
  try {
    return validate();
  } catch (error) {
    throw new ProviderResponseError(error, reportedReceipt(raw));
  }
}
