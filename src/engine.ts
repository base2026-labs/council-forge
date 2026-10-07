import {
  OpinionSchema,
  VerificationSchema,
  ChairSchema,
  type Agent,
  type Claim,
  type Settings,
  type Verification,
  type Evidence,
} from './schema.ts';
import {
  CouncilError,
  preflight,
  selectModel,
  Semaphore,
  reserveEstimate,
  usdToMicro,
  fail,
} from './policy.ts';
import { Store } from './store.ts';
import type { Provider, Invocation, Completion } from './provider.ts';
import { proposerPrompt, critiquePrompt, verifierPrompt, chairPrompt } from './prompts.ts';
import { councilCapabilities } from './capabilities.ts';
import { ROLE_CONTRACTS } from './roles.ts';
import type { GlobalCoordinator } from './global.ts';
import { createHash } from 'node:crypto';
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
export function evaluateClaims(
  claims: Claim[],
  verification: Verification,
  evidenceIds: string[],
  evidence?: Evidence[],
) {
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
      check.evidenceIds.every((id) => known.has(id)) &&
      (!evidence ||
        check.evidenceIds.some((id) =>
          evidence.some((e) => e.id === id && e.kind !== 'hypothesis'),
        ));
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
    private global?: GlobalCoordinator,
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
    const context = {
      outputLanguage: r.outputLanguage,
      permissionScope: r.permissionScope,
      capabilities: councilCapabilities(),
      modelSelections: r.agents,
      concurrency: {
        limit: this.settings.maxConcurrency,
        scope: this.global?.path ?? 'in-process simulation',
        sharedAcrossRuns: Boolean(this.global),
      },
      evidence: r.evidence.map((e) => ({
        ...e,
        sha256: createHash('sha256').update(e.excerpt, 'utf8').digest('hex'),
        provenance: e.provenance ?? {
          collector: 'caller-supplied',
          scope: e.source,
          permission: 'read',
          sourceReported: true,
          limitations: [
            'Caller-supplied evidence was not independently collected by this runtime.',
          ],
        },
      })),
    };
    if (p.missingEvidence)
      return {
        runId: r.runId,
        state: 'needs_input',
        ...context,
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
    const use = <T>(fn: () => Promise<T>) =>
      this.semaphore.use(signal, () =>
        this.global ? this.global.use(this.settings.maxConcurrency, signal, fn) : fn(),
      );
    const call = async (
      agent: Agent,
      phase: Invocation['phase'],
      prompt: string,
      claims: Claim[] = [],
    ): Promise<string> =>
      use(async () => {
        const { provider, model } = selectModel(this.settings, agent);
        const adapter = this.providers.get(provider.id);
        if (!adapter) return fail('ADAPTER_MISSING', 'No runtime adapter is registered.');
        const paid = ['openrouter', 'openai-compatible'].includes(provider.kind);
        const callId = `${r.runId}/${phase}/${agent.id}`;
        if (Buffer.byteLength(prompt) > 512000)
          fail('PROMPT_TOO_LARGE', 'Expanded deliberation context exceeds the alpha limit.');
        if (paid) {
          const estimate = reserveEstimate(
            model,
            prompt,
            r.maxOutputTokens,
            this.settings.maxPriceAgeHours,
          );
          this.global?.budget.reserve(
            callId,
            r.runId,
            estimate,
            usdToMicro(r.apiBudgetUsd),
            usdToMicro(this.settings.apiLifetimeLimitUsd),
          );
          try {
            this.store.reserve(
              callId,
              r.runId,
              reserveEstimate(model, prompt, r.maxOutputTokens, this.settings.maxPriceAgeHours),
              usdToMicro(r.apiBudgetUsd),
              usdToMicro(this.settings.apiLifetimeLimitUsd),
            );
          } catch (error) {
            this.global?.budget.settle(callId, 0);
            throw error;
          }
        }
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
            outputLanguage: r.outputLanguage,
          });
        } catch (error) {
          if (paid) {
            this.store.settle(callId, null);
            this.global?.budget.settle(callId, null);
          }
          receipts.push({
            agent: agent.id,
            phase,
            requestedModel: agent.model,
            requestedEffort: agent.effort ?? null,
            state: 'held',
            errorCode: error instanceof CouncilError ? error.code : 'PROVIDER_OR_SCHEMA_ERROR',
            diagnostic: error instanceof CouncilError ? (error.diagnostic ?? null) : null,
            usage: { inputTokens: null, outputTokens: null, costUsd: null },
          });
          throw error;
        }
        if (paid) {
          const charged = result.usage.costUsd === null ? null : usdToMicro(result.usage.costUsd);
          try {
            this.store.settle(callId, charged);
          } finally {
            this.global?.budget.settle(callId, charged);
          }
        }
        const receipt = {
          agent: agent.id,
          phase,
          provider: provider.id,
          requestedModel: agent.model,
          actualModel: result.actualModel,
          requestedEffort: agent.effort ?? null,
          actualEffort: result.actualEffort ?? null,
          effortReceipt: result.actualEffort
            ? 'provider-attested'
            : 'requested-only; actual effort unknown',
          capabilityReceipt: result.capabilityReceipt ?? councilCapabilities(),
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
        advice = await use(async () => {
          const id = `${r.runId}/jev`;
          this.global?.budget.reserve(
            id,
            r.runId,
            usdToMicro(this.settings.jev.reservationUsd),
            usdToMicro(r.apiBudgetUsd),
            usdToMicro(this.settings.apiLifetimeLimitUsd),
          );
          try {
            this.store.reserve(
              id,
              r.runId,
              usdToMicro(this.settings.jev.reservationUsd),
              usdToMicro(r.apiBudgetUsd),
              usdToMicro(this.settings.apiLifetimeLimitUsd),
            );
          } catch (error) {
            this.global?.budget.settle(id, 0);
            throw error;
          }
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
            this.global?.budget.settle(id, null);
            throw error;
          }
          try {
            this.store.settle(id, result.costUsd === null ? null : usdToMicro(result.costUsd));
          } finally {
            this.global?.budget.settle(
              id,
              result.costUsd === null ? null : usdToMicro(result.costUsd),
            );
          }
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
          OpinionSchema.parse(
            JSON.parse(
              await call(
                a,
                'propose',
                proposerPrompt(a, {
                  ...r,
                  evidence: r.evidence.filter((e) =>
                    ROLE_CONTRACTS[a.role].allowedEvidenceKinds.includes(e.kind),
                  ),
                }),
              ),
            ),
          ),
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
        r.evidence,
      );
      const objections = [...opinions.flatMap((o) => o.objections), ...critique.objections];
      for (const o of objections)
        if (o.severity !== 'minor')
          gate.blockers.push(`Unresolved ${o.severity} objection: ${o.text}`);
      const decision = gate.blockers.length ? 'hold' : 'accepted_for_review';
      const packet = { task: r.task, decision, claims, verification, objections, gate };
      const chair = p.agents.find((a) => a.role === 'chair')!;
      const synthesis = ChairSchema.parse(
        JSON.parse(await call(chair, 'chair', chairPrompt(packet, r.outputLanguage), claims)),
      );
      const result = {
        runId: r.runId,
        state: 'completed',
        simulation: p.simulation,
        ...context,
        decision,
        productionAuthorized: false,
        advice,
        gate,
        claims,
        proposals: opinions.map((opinion, i) => ({
          agent: independent[i]!.id,
          role: independent[i]!.role,
          opinion,
        })),
        critique,
        verification,
        objections,
        synthesis,
        receipts,
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
        ...context,
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
