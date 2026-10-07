import { z } from 'zod';
import type { Settings } from '../schema.ts';
import type { Router, JevAdvice } from '../engine.ts';
import { fail } from '../policy.ts';
import { envSecret, jsonFetch } from './http.ts';
export const JEV_CHOICES = {
  run_current_council:
    'The preflighted council is appropriate; retain all pinned models, efforts, agent counts and permissions.',
  request_more_evidence:
    'The supplied evidence coverage is insufficient; ask the host to retrieve bounded evidence without changing the model route.',
  request_deeper_review:
    'The current task deserves owner-reviewed deeper analysis; do not silently change any model or spend limit.',
};
const Reply = z.object({
  model: z.string(),
  id: z.string().optional(),
  answers: z.object({
    next_action: z.object({
      type: z.literal('choice'),
      choice: z.enum(['run_current_council', 'request_more_evidence', 'request_deeper_review']),
      confidence: z.number().min(0).max(1),
      probabilities: z.record(z.string(), z.number().min(0).max(1)),
    }),
  }),
  usage: z.object({ cost: z.number().finite().nonnegative().optional() }).optional(),
});
export class JevDecisionRouter implements Router {
  constructor(
    private settings: Settings['jev'],
    private fetcher: typeof fetch = fetch,
  ) {}
  async advise(metrics: Record<string, number | string>, signal: AbortSignal): Promise<JevAdvice> {
    if (!this.settings.enabled) fail('JEV_DISABLED', 'Jev is not enabled.');
    // Never forward the raw task, source URLs, source text, credentials or customer data.
    const state = z
      .object({
        taskKind: z.enum(['seo_audit', 'code_review', 'research', 'architecture']),
        agentCount: z.number().int().min(4).max(32),
        evidenceCount: z.number().int().min(0).max(100),
        apiBudgetUsd: z.number().nonnegative(),
      })
      .strict()
      .parse(metrics);
    const out = Reply.parse(
      await jsonFetch(
        new URL('https://openrouter.ai/api/alpha/decisions'),
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${envSecret(this.settings.keyEnv)}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: this.settings.model,
            state,
            questions: {
              next_action: {
                type: 'choice',
                instructions:
                  'Choose an advisory next action using only these coarse metrics. This is not factual verification or authorization.',
                criteria: JEV_CHOICES,
              },
            },
          }),
          signal,
        },
        this.fetcher,
      ),
    );
    if (out.model !== this.settings.model)
      fail('JEV_MODEL_MISMATCH', 'Jev response differs from the pinned decision model.');
    const a = out.answers.next_action,
      keys = Object.keys(a.probabilities);
    if (
      keys.length !== 3 ||
      keys.some((k) => !(k in JEV_CHOICES)) ||
      Math.abs(Object.values(a.probabilities).reduce((s, p) => s + p, 0) - 1) > 0.02
    )
      fail(
        'JEV_INVALID_DISTRIBUTION',
        'Decision distribution is inconsistent with the candidate set.',
      );
    return {
      choice: a.choice,
      confidence: a.confidence,
      model: out.model,
      requestId: out.id ?? null,
      costUsd: out.usage?.cost ?? null,
    };
  }
}
