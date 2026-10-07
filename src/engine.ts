import {
  OpinionSchema,
  VerificationSchema,
  ChairSchema,
  type CouncilRequest,
  type Agent,
  type Claim,
  type Settings,
  type Verification,
} from './schema.ts';
import {
  CouncilError,
  preflight,
  selectModel,
  Semaphore,
  reserveEstimate,
  usdToMicro,
  fail,
  hash,
} from './policy.ts';
import { Store } from './store.ts';
import type { Provider, Invocation, Completion } from './provider.ts';
import { proposerPrompt, critiquePrompt, verifierPrompt, chairPrompt } from './prompts.ts';
export interface JevAdvice {
  choice: string;
  confidence: number;
  model: string;
  requestId: string | null;
  costUsd: number | null;
}
export interface Router {
  advise(metrics: Record<string, number | string>, signal: AbortSignal): Promise<JevAdvice>;
}
export function evaluateClaims(claims: Claim[], verification: Verification, evidenceIds: string[]) {
  const known = new Set(evidenceIds),
    claimIds = new Set(claims.map((c) => c.id));
  const blockers: string[] = [];
  if (!claims.length)
    blockers.push('No factual claims were produced; evidence coverage cannot be established.');
  if (new Set(verification.checks.map((c) => c.claimId)).size !== verification.checks.length)
    blockers.push('Verifier returned duplicate claim checks.');
  if (verification.checks.some((c) => !claimIds.has(c.claimId)))
    blockers.push('Verifier returned an unknown claim ID.');
  let supported = 0;
  for (const claim of claims) {
    const check = verification.checks.find((c) => c.claimId === claim.id);
    const valid =
      claim.evidenceIds.length > 0 &&
      claim.evidenceIds.every((id) => known.has(id)) &&
      check?.verdict === 'supported' &&
      check.evidenceIds.length > 0 &&
      check.evidenceIds.every((id) => known.has(id));
    if (valid) supported++;
    else
      blockers.push(
        `${claim.id}: independent support is absent, contradicted, or references invalid evidence.`,
      );
  }
  return {
    blockers,
    supported,
    total: claims.length,
    evidenceCoverage: claims.length ? supported / claims.length : null,
  };
}
export class CouncilEngine {
  private semaphore: Semaphore;
  private controllers = new Map<string, AbortController>();
  constructor(
    public readonly settings: Settings,
    public readonly store: Store,
    private providers: Map<string, Provider>,
    private router?: Router,
  ) {
    this.semaphore = new Semaphore(settings.maxConcurrency);
  }
  cancel(runId: string) {
    const c = this.controllers.get(runId);
    c?.abort(new CouncilError('CANCELLED', 'Run cancelled.'));
    return Boolean(c);
  }
  async run(raw: unknown): Promise<unknown> {
    const p = preflight(this.settings, raw),
      r = p.request;
    if (p.missingEvidence)
      return {
        runId: r.runId,
        state: 'needs_input',
        reason:
          'Attach observations or a source document before deliberation. No inference was dispatched.',
      };
    if (!p.simulation && !this.settings.liveEnabled)
      fail('LIVE_DISABLED', 'Live inference is disabled by the operator.');
    const previous = this.store.begin(r.runId, p.requestHash);
    if (previous)
      return previous.result ?? { runId: r.runId, state: previous.state, replayed: false };
    const controller = new AbortController();
    this.controllers.set(r.runId, controller);
    const timer = setTimeout(
      () => controller.abort(new CouncilError('TIMEOUT', 'Run deadline reached.')),
      r.timeoutMs,
    );
    const receipts: unknown[] = [];
    const signal = controller.signal;
    const call = async (
      agent: Agent,
      phase: Invocation['phase'],
      prompt: string,
      claims: Claim[] = [],
    ): Promise<string> =>
      this.semaphore.use(signal, async () => {
        const { provider, model } = selectModel(this.settings, agent);
        const adapter = this.providers.get(provider.id);
        if (!adapter) return fail('ADAPTER_MISSING', 'No runtime adapter is registered.');
        const paid = ['openrouter', 'openai-compatible'].includes(provider.kind);
        const callId = `${r.runId}/${phase}/${agent.id}`;
        if (Buffer.byteLength(prompt) > 512000)
          fail('PROMPT_TOO_LARGE', 'Expanded deliberation context exceeds the alpha limit.');
        if (paid)
          this.store.reserve(
            callId,
            r.runId,
            reserveEstimate(model, prompt, r.maxOutputTokens, this.settings.maxPriceAgeHours),
            usdToMicro(r.apiBudgetUsd),
            usdToMicro(this.settings.apiLifetimeLimitUsd),
          );
        this.store.event(r.runId, 'agent_started', {
          agent: agent.id,
          phase,
          provider: provider.id,
          model: agent.model,
          effort: agent.effort ?? null,
        });
        let result: Completion;
        try {
          result = await adapter.complete({
            agent,
            phase,
            prompt,
            maxOutputTokens: r.maxOutputTokens,
            signal,
            evidence: r.evidence,
            claims,
          });
        } catch (error) {
          if (paid) this.store.settle(callId, null);
          throw error;
        }
        if (paid)
          this.store.settle(
            callId,
            result.usage.costUsd === null ? null : usdToMicro(result.usage.costUsd),
          );
        const receipt = {
          agent: agent.id,
          phase,
          provider: provider.id,
          requestedModel: agent.model,
          actualModel: result.actualModel,
          requestedEffort: agent.effort ?? null,
          requestId: result.requestId,
          billing: provider.kind === 'mock' ? 'simulation' : paid ? 'api' : 'subscription',
          usage: result.usage,
        };
        receipts.push(receipt);
        this.store.event(r.runId, 'agent_completed', receipt);
        if (!model.responseIds.includes(result.actualModel))
          fail('MODEL_MISMATCH', 'Provider returned an unapproved model identity.');
        if (paid && result.usage.costUsd === null)
          fail(
            'USAGE_UNKNOWN',
            'Paid result has no cost receipt. Reservation is retained; no automatic retry.',
          );
        signal.throwIfAborted();
        return result.text;
      });
    try {
      let advice: JevAdvice | null = null;
      if (r.useJev) {
        if (!this.router) fail('JEV_UNAVAILABLE', 'Jev adapter is not registered.');
        advice = await this.semaphore.use(signal, async () => {
          const id = `${r.runId}/jev`;
          this.store.reserve(
            id,
            r.runId,
            usdToMicro(this.settings.jev.reservationUsd),
            usdToMicro(r.apiBudgetUsd),
            usdToMicro(this.settings.apiLifetimeLimitUsd),
          );
          let result: JevAdvice;
          try {
            result = await this.router!.advise(
              {
                taskKind: r.kind,
                agentCount: p.agents.length,
                evidenceCount: r.evidence.length,
                apiBudgetUsd: r.apiBudgetUsd,
              },
              signal,
            );
          } catch (error) {
            this.store.settle(id, null);
            throw error;
          }
          this.store.settle(id, result.costUsd === null ? null : usdToMicro(result.costUsd));
          if (result.costUsd === null)
            fail('USAGE_UNKNOWN', 'Jev cost is unknown. Reservation retained.');
          this.store.event(r.runId, 'jev_advice', result);
          return result;
        });
        if (
          advice.confidence < this.settings.jev.confidenceThreshold ||
          advice.choice !== 'run_current_council'
        )
          fail(
            'JEV_HOLD',
            'Jev advice requests review, more evidence, or is below the configured threshold. It cannot select unapproved models.',
          );
      }
      const independent = p.agents.filter(
        (a) => !['skeptic', 'verifier', 'chair'].includes(a.role),
      );
      const attempts = await Promise.allSettled(
        independent.map(async (a) =>
          OpinionSchema.parse(JSON.parse(await call(a, 'propose', proposerPrompt(a, r)))),
        ),
      );
      const failed = attempts.find((a) => a.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      const opinions = attempts.map((a) => {
        if (a.status === 'fulfilled') return a.value;
        throw new Error('Unreachable');
      });
      const claims: Claim[] = opinions
        .flatMap((o) => o.claims)
        .map((c, n) => ({ ...c, id: `C${n + 1}` }));
      const skeptic = p.agents.find((a) => a.role === 'skeptic')!;
      const critique = OpinionSchema.parse(
        JSON.parse(await call(skeptic, 'critique', critiquePrompt(r, claims, opinions), claims)),
      );
      const verifier = p.agents.find((a) => a.role === 'verifier')!;
      const verification = VerificationSchema.parse(
        JSON.parse(await call(verifier, 'verify', verifierPrompt(r, claims), claims)),
      );
      const gate = evaluateClaims(
        claims,
        verification,
        r.evidence.map((e) => e.id),
      );
      const objections = [...opinions.flatMap((o) => o.objections), ...critique.objections];
      for (const o of objections)
        if (o.severity !== 'minor')
          gate.blockers.push(`Unresolved ${o.severity} objection: ${o.text}`);
      const decision = gate.blockers.length ? 'hold' : 'accepted_for_review';
      const packet = { task: r.task, decision, claims, verification, objections, gate };
      const chair = p.agents.find((a) => a.role === 'chair')!;
      const synthesis = ChairSchema.parse(
        JSON.parse(await call(chair, 'chair', chairPrompt(packet), claims)),
      );
      const result = {
        runId: r.runId,
        state: 'completed',
        simulation: p.simulation,
        decision,
        productionAuthorized: false,
        advice,
        gate,
        claims,
        verification,
        objections,
        synthesis,
        receipts,
        evidence: r.evidence.map((e) => ({
          id: e.id,
          source: e.source,
          observedAt: e.observedAt,
          kind: e.kind,
          sha256: hash(e.excerpt),
        })),
        apiExposureUsd: this.store.exposure(r.runId) / 1e6,
      };
      this.store.finish(r.runId, 'completed', result);
      return result;
    } catch (error) {
      const code =
        error instanceof CouncilError
          ? error.code
          : signal.aborted
            ? 'CANCELLED'
            : 'PROVIDER_OR_SCHEMA_ERROR';
      // Do not persist arbitrary provider error bodies: they can contain credentials or prompt fragments.
      const result = {
        runId: r.runId,
        state: signal.aborted ? 'cancelled' : 'held',
        decision: 'hold',
        simulation: p.simulation,
        productionAuthorized: false,
        errorCode: code,
        receipts,
        apiExposureUsd: this.store.exposure(r.runId) / 1e6,
      };
      this.store.event(r.runId, 'run_held', { code });
      this.store.finish(r.runId, String(result.state), result);
      return result;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(r.runId);
    }
  }
}
