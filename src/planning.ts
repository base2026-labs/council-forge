import { z } from 'zod';
import { Identifier, RequestSchema } from './schema.ts';
import { preflight, hash, fail } from './policy.ts';
export const CandidateSchema = z
  .object({
    id: Identifier,
    rationale: z.string().min(1).max(2000),
    request: RequestSchema,
  })
  .strict();
export function admitCandidatePlans(settings: unknown, current: unknown, candidates: unknown) {
  const base = preflight(settings, current);
  const plans = z.array(CandidateSchema).min(1).max(8).parse(candidates);
  if (new Set(plans.map((p) => p.id)).size !== plans.length)
    fail('DUPLICATE_PLAN', 'Candidate IDs must be unique.');
  // Every configured model/effort/count is a user pin in this version. A candidate
  // cannot exploit a new run ID, mode, evidence packet, budget or language to weaken it.
  const fixed = (r: typeof base.request) => ({ ...r, runId: undefined });
  return plans.map((plan) => {
    const candidate = preflight(settings, plan.request);
    if (hash(fixed(base.request)) !== hash(fixed(candidate.request)))
      fail(
        'PLAN_PIN_CONFLICT',
        'Candidate changes user pins, budget, evidence, mode, language or permissions.',
      );
    return {
      ...plan,
      request: candidate.request,
      requestHash: candidate.requestHash,
      protocol: 'one_round',
      automaticSwitch: false,
    };
  });
}
export function evidenceAdvice(evidenceCount: number, unresolvedObjections: number) {
  return {
    choice:
      evidenceCount === 0
        ? 'request_evidence'
        : unresolvedObjections > 0
          ? 'request_deeper_review'
          : 'retain_current_council',
    automaticSwitch: false,
    permissionExpansion: false,
    modelChange: false,
  };
}
