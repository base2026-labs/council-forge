import { z } from 'zod';
import type { ProviderSettings } from '../schema.ts';
import type { Invocation, Completion, Provider } from '../provider.ts';
import { fail } from '../policy.ts';
import { envSecret, httpsEndpoint, jsonFetch } from './http.ts';
const Envelope = z.object({
  id: z.string().optional(),
  model: z.string(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string(), tool_calls: z.array(z.unknown()).optional() }),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative().optional(),
      completion_tokens: z.number().int().nonnegative().optional(),
      cost: z.number().finite().nonnegative().optional(),
    })
    .optional(),
});
export class OpenAICompatibleProvider implements Provider {
  constructor(
    private config: ProviderSettings,
    private fetcher: typeof fetch = fetch,
  ) {
    if (!['openrouter', 'openai-compatible'].includes(config.kind))
      fail('PROVIDER_KIND', 'This adapter requires an API provider.');
    if (
      config.kind === 'openrouter' &&
      config.baseUrl &&
      config.baseUrl !== 'https://openrouter.ai/api/v1'
    )
      fail('ENDPOINT_PINNED', 'OpenRouter transport uses its official endpoint only.');
    if (config.kind === 'openai-compatible' && !config.baseUrl)
      fail('ENDPOINT_REQUIRED', 'An explicit trusted provider base URL is required.');
  }
  async complete(input: Invocation): Promise<Completion> {
    const model = this.config.models.find((m) => m.id === input.agent.model);
    if (!model) return fail('UNKNOWN_MODEL', 'Model not configured.');
    if (input.agent.effort && !model.efforts.includes(input.agent.effort))
      fail('UNSUPPORTED_EFFORT', 'Requested effort is unsupported.');
    const isRouter = this.config.kind === 'openrouter';
    const body: Record<string, unknown> = {
      model: input.agent.model,
      messages: [{ role: 'user', content: input.prompt }],
      max_tokens: input.maxOutputTokens,
      stream: false,
    };
    if (model.jsonMode) body.response_format = { type: 'json_object' };
    if (input.agent.effort) {
      if (isRouter) body.reasoning = { effort: input.agent.effort };
      else body.reasoning_effort = input.agent.effort;
    }
    if (isRouter) body.provider = { allow_fallbacks: false, require_parameters: true };
    const raw = await jsonFetch(
      httpsEndpoint(
        isRouter ? 'https://openrouter.ai/api/v1' : this.config.baseUrl!,
        'chat/completions',
      ),
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${envSecret(this.config.keyEnv ?? 'OPENROUTER_API_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: input.signal,
      },
      this.fetcher,
    );
    const out = Envelope.parse(raw),
      choice = out.choices[0]!;
    if (choice.message.tool_calls?.length)
      fail('UNSUPPORTED_TOOL_CALL', 'Alpha API adapters do not execute model-supplied tools.');
    if (choice.finish_reason !== 'stop')
      fail('INCOMPLETE_GENERATION', 'Only a completed stop response is accepted.');
    const usage = out.usage;
    // OpenRouter reports cost; compatible endpoints may not. Do not invent an invoice amount.
    // A compatible endpoint without usage.cost is held by the engine for reconciliation.
    return {
      text: choice.message.content,
      actualModel: out.model,
      requestId: out.id ?? null,
      usage: {
        inputTokens: usage?.prompt_tokens ?? null,
        outputTokens: usage?.completion_tokens ?? null,
        costUsd: usage?.cost ?? null,
      },
    };
  }
}
export interface DiscoveredModel {
  id: string;
  label: string;
  supportedParameters: string[];
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  observedAt: string;
}
export async function discoverOpenRouter(
  fetcher: typeof fetch = fetch,
): Promise<DiscoveredModel[]> {
  const raw = await jsonFetch(
    new URL('https://openrouter.ai/api/v1/models'),
    { signal: AbortSignal.timeout(15000) },
    fetcher,
  );
  const schema = z.object({
    data: z.array(
      z.object({
        id: z.string(),
        name: z.string().optional(),
        supported_parameters: z.array(z.string()).optional(),
        pricing: z
          .object({ prompt: z.string().optional(), completion: z.string().optional() })
          .optional(),
      }),
    ),
  });
  const price = (v: string | undefined) =>
    v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) * 1e6 : null;
  return schema.parse(raw).data.map((m) => ({
    id: m.id,
    label: m.name ?? m.id,
    supportedParameters: m.supported_parameters ?? [],
    inputUsdPerMillion: price(m.pricing?.prompt),
    outputUsdPerMillion: price(m.pricing?.completion),
    observedAt: new Date().toISOString(),
  }));
}
