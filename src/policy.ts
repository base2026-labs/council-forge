import { createHash } from 'node:crypto';
import {
  SettingsSchema,
  RequestSchema,
  type Settings,
  type CouncilRequest,
  type Agent,
  type ModelSettings,
} from './schema.ts';
export class CouncilError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CouncilError';
  }
}
export const fail = (code: string, message: string): never => {
  throw new CouncilError(code, message);
};
export function hash(value: unknown): string {
  const normalize = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(normalize)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, normalize(x)]),
          )
        : v;
  return createHash('sha256')
    .update(JSON.stringify(normalize(value)))
    .digest('hex');
}
export const usdToMicro = (usd: number): number => {
  if (!Number.isFinite(usd) || usd < 0 || usd > 1000000)
    fail('INVALID_COST', 'Cost must be finite and nonnegative.');
  return Math.ceil(usd * 1e6);
};
export function selectModel(settings: Settings, agent: Agent) {
  const provider = settings.providers.find((p) => p.id === agent.providerId);
  if (!provider) return fail('UNKNOWN_PROVIDER', 'Provider is not in the operator catalogue.');
  const model = provider.models.find((m) => m.id === agent.model);
  if (!model) return fail('UNKNOWN_MODEL', 'Model is not in the operator catalogue.');
  if (agent.effort && !model.efforts.includes(agent.effort))
    fail('UNSUPPORTED_EFFORT', 'Requested reasoning effort is not explicitly supported.');
  return { provider, model };
}
export function preflight(rawSettings: unknown, rawRequest: unknown) {
  const settings = SettingsSchema.parse(rawSettings);
  const request = RequestSchema.parse(rawRequest);
  if (new Set(settings.providers.map((p) => p.id)).size !== settings.providers.length)
    fail('DUPLICATE_PROVIDER', 'Provider IDs must be unique.');
  if (new Set(request.agents.map((a) => a.id)).size !== request.agents.length)
    fail('DUPLICATE_AGENT', 'Agent IDs must be unique.');
  if (new Set(request.evidence.map((e) => e.id)).size !== request.evidence.length)
    fail('DUPLICATE_EVIDENCE', 'Evidence IDs must be unique.');
  if (request.evidence.some((e) => Date.parse(e.observedAt) > Date.now() + 300000))
    fail('FUTURE_EVIDENCE', 'Evidence timestamps cannot be in the future.');
  if (!settings.allowedModes.includes(request.mode))
    fail('MODE_NOT_ALLOWED', 'The operator has not enabled this billing mode.');
  if (request.apiBudgetUsd > settings.maxRunApiUsd)
    fail('BUDGET_NOT_ALLOWED', 'Requested API budget exceeds the operator limit.');
  const agents: Agent[] = request.agents.flatMap((a) =>
    Array.from({ length: a.instances }, (_, n) => ({
      ...a,
      id: a.instances === 1 ? a.id : `${a.id}-${n + 1}`,
      instances: 1,
    })),
  );
  if (new Set(agents.map((a) => a.id)).size !== agents.length)
    fail('DUPLICATE_AGENT', 'Expanded agent IDs collide.');
  if (agents.length > settings.maxAgents)
    fail('AGENT_LIMIT', 'Agent count exceeds the operator limit.');
  for (const role of ['skeptic', 'verifier', 'chair'])
    if (agents.filter((a) => a.role === role).length !== 1)
      fail('REQUIRED_ROLE', `Exactly one ${role} is required.`);
  if (!agents.some((a) => !['skeptic', 'verifier', 'chair'].includes(a.role)))
    fail('NO_PROPOSER', 'At least one independent proposer is required.');
  const kinds = agents.map((a) => selectModel(settings, a).provider.kind);
  const simulation = kinds.every((k) => k === 'mock');
  if (!simulation && kinds.includes('mock'))
    fail('MIXED_SIMULATION', 'Mock and live providers cannot share a council.');
  if (
    request.mode === 'subscription_only' &&
    (kinds.some((k) => ['openrouter', 'openai-compatible'].includes(k)) || request.useJev)
  )
    fail('API_FORBIDDEN', 'Subscription-only forbids external inference, including Jev.');
  if (request.mode === 'api_only' && kinds.includes('codex-local'))
    fail('SUBSCRIPTION_FORBIDDEN', 'API-only forbids subscription inference.');
  if (request.useJev && (!settings.jev.enabled || simulation))
    fail('JEV_DISABLED', 'Jev requires explicit operator enablement and a live council.');
  if (kinds.some((k) => ['openrouter', 'openai-compatible'].includes(k)) || request.useJev) {
    if (request.apiBudgetUsd <= 0 || settings.apiLifetimeLimitUsd <= 0)
      fail('BUDGET_REQUIRED', 'External API inference requires a positive explicit budget.');
  }
  if (agents.length + (request.useJev ? 1 : 0) > settings.maxCallsPerRun)
    fail('CALL_LIMIT', 'Planned calls exceed the operator cap.');
  if (JSON.stringify(request).length > 200000)
    fail('INPUT_TOO_LARGE', 'Council inputs exceed the bounded context envelope.');
  const missingEvidence = request.evidence.length === 0;
  return {
    settings,
    request,
    agents,
    simulation,
    missingEvidence,
    status: missingEvidence ? 'needs_input' : 'ready',
    requestHash: hash(request),
    maxConcurrency: settings.maxConcurrency,
    plannedCalls: agents.length + (request.useJev ? 1 : 0),
    warnings: [
      'Evidence references and hashes do not prove semantic truth. Independent review is still fallible.',
      'API admission reservations are not a provider-enforced invoice cap. Configure provider-side spending limits.',
      'Subscription calls consume plan allowance; remaining usage and monetary cost may be unknown.',
    ],
  };
}
export function reserveEstimate(
  model: ModelSettings,
  prompt: string,
  maxOutputTokens: number,
  maxAgeHours: number,
): number {
  if (
    model.inputUsdPerMillion === undefined ||
    model.outputUsdPerMillion === undefined ||
    !model.priceAsOf
  )
    return fail('PRICE_UNKNOWN', 'A dated price snapshot is required before paid inference.');
  const age = Date.now() - Date.parse(model.priceAsOf);
  if (age < -300000 || age > maxAgeHours * 3600000)
    fail('PRICE_STALE', 'Refresh the operator price snapshot.');
  // Deliberately conservative text estimate, NOT a tokenizer-proof or provider billing guarantee.
  const inputEstimate = Buffer.byteLength(prompt, 'utf8') + 2048;
  return Math.max(
    1,
    Math.ceil(
      (inputEstimate * model.inputUsdPerMillion + maxOutputTokens * model.outputUsdPerMillion) *
        1.25,
    ),
  );
}
export class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async use<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    await new Promise<void>((resolve) => {
      const acquire = () => {
        this.active++;
        resolve();
      };
      if (this.active < this.limit) acquire();
      else this.waiting.push(acquire);
    });
    try {
      signal.throwIfAborted();
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }
}
