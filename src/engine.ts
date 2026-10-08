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
import type { Provider, Invocation, Completion, ProviderReceipt } from './provider.ts';
import { ProviderResponseError } from './provider.ts';
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
  usage?: Completion['usage'];
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
    private nativeAdmission?: { runId: string; requestSha256: string },
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
    if (
      !p.simulation &&
      this.nativeAdmission &&
      (r.runId !== this.nativeAdmission.runId ||
        p.requestHash !== this.nativeAdmission.requestSha256)
    )
      fail(
        'NATIVE_ADMISSION_SCOPE',
        'Native admission is bound to one exact run and normalized request.',
      );
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
    // Stop admission separately from cancellation: already dispatched transports
    // must still yield their outcome and settle every known charge.
    const admission = new AbortController();
    const admissionSignal = AbortSignal.any([signal, admission.signal]);
    let accountingFailure: unknown;
    const errorCode = (error: unknown) =>
      error instanceof CouncilError ? error.code : 'PROVIDER_OR_SCHEMA_ERROR';
    const stopAdmission = (error: unknown) => {
      if (!accountingFailure || errorCode(error) === 'COST_OVERRUN') accountingFailure = error;
      admission.abort(accountingFailure);
    };
    const use = <T>(fn: () => Promise<T>) =>
      this.semaphore.use(admissionSignal, () =>
        this.global ? this.global.use(this.settings.maxConcurrency, admissionSignal, fn) : fn(),
      );
    const reserve = (id: string, amount: number) => {
      try {
        this.global?.budget.reserve(
          id,
          r.runId,
          amount,
          usdToMicro(r.apiBudgetUsd),
          usdToMicro(this.settings.apiLifetimeLimitUsd),
        );
        try {
          this.store.reserve(
            id,
            r.runId,
            amount,
            usdToMicro(r.apiBudgetUsd),
            usdToMicro(this.settings.apiLifetimeLimitUsd),
          );
        } catch (error) {
          this.global?.budget.settle(id, 0);
          throw error;
        }
      } catch (error) {
        stopAdmission(error);
        throw error;
      }
    };
    const settle = (id: string, costUsd: number | null) => {
      let charged: number | null = null;
      let failure: unknown;
      try {
        charged = costUsd === null ? null : usdToMicro(costUsd);
      } catch (error) {
        failure = error;
        stopAdmission(error);
      }
      // Each ledger commits actual/UNKNOWN exposure even when the other reports
      // an overrun. A thrown settlement must never discard an in-flight receipt.
      for (const ledger of [this.store, this.global?.budget]) {
        if (!ledger) continue;
        try {
          ledger.settle(id, charged);
        } catch (error) {
          if (!failure || errorCode(error) === 'COST_OVERRUN') failure = error;
          stopAdmission(error);
        }
      }
      if (!failure && costUsd === null) {
        failure = new CouncilError(
          'USAGE_UNKNOWN',
          'Cost is unknown. Reservation retained; no automatic retry.',
        );
        stopAdmission(failure);
      }
      if (failure) throw failure;
    };
    const account = async <T, R>(
      callId: string,
      paid: boolean,
      details: Record<string, unknown>,
      send: () => Promise<T>,
      receiptFor: (value: T) => ProviderReceipt,
      accept: (value: T) => R,
    ): Promise<R> => {
      let value: T | undefined;
      let rejected: unknown;
      try {
        value = await send();
      } catch (error) {
        rejected = error;
      }
      const observed =
        value !== undefined
          ? receiptFor(value)
          : rejected instanceof ProviderResponseError
            ? rejected.receipt
            : {
                actualModel: null,
                requestId: null,
                usage: { inputTokens: null, outputTokens: null, costUsd: null },
              };
      const receipt = {
        ...details,
        ...observed,
        callId,
        state: 'received',
        responseErrorCode: rejected ? errorCode(rejected) : null,
        errorCode: null as string | null,
        diagnostic: rejected instanceof CouncilError ? (rejected.diagnostic ?? null) : null,
      };
      receipts.push(receipt);
      this.store.event(r.runId, 'call_received', receipt);
      try {
        if (paid) settle(callId, observed.usage.costUsd);
        if (rejected) throw rejected;
        const accepted = accept(value!);
        signal.throwIfAborted();
        receipt.state = 'completed';
        this.store.event(
          r.runId,
          details.phase === 'jev' ? 'jev_advice' : 'agent_completed',
          receipt,
        );
        return accepted;
      } catch (error) {
        receipt.state = 'held';
        receipt.errorCode = errorCode(error);
        this.store.event(r.runId, details.phase === 'jev' ? 'jev_held' : 'agent_held', receipt);
        throw error;
      }
    };
    const call = async <T>(
      agent: Agent,
      phase: Invocation['phase'],
      prompt: string,
      parse: (text: string) => T,
      claims: Claim[] = [],
    ): Promise<T> =>
      use(async () => {
        const { provider, model } = selectModel(this.settings, agent);
        const adapter = this.providers.get(provider.id);
        if (!adapter) return fail('ADAPTER_MISSING', 'No runtime adapter is registered.');
        const paid = ['openrouter', 'openai-compatible'].includes(provider.kind);
        const callId = `${r.runId}/${phase}/${agent.id}`;
        if (Buffer.byteLength(prompt) > 512000)
          fail('PROMPT_TOO_LARGE', 'Expanded deliberation context exceeds the alpha limit.');
        if (paid)
          reserve(
            callId,
            reserveEstimate(model, prompt, r.maxOutputTokens, this.settings.maxPriceAgeHours),
          );
        const details = {
          agent: agent.id,
          phase,
          provider: provider.id,
          requestedModel: agent.model,
          requestedEffort: agent.effort ?? null,
          billing: provider.kind === 'mock' ? 'simulation' : paid ? 'api' : 'subscription',
        };
        this.store.event(r.runId, 'agent_started', {
          ...details,
          callId,
          model: agent.model,
          effort: agent.effort ?? null,
        });
        return account(
          callId,
          paid,
          details,
          () =>
            adapter.complete({
              agent,
              phase,
              prompt,
              maxOutputTokens: r.maxOutputTokens,
              signal,
              evidence: r.evidence,
              claims,
              outputLanguage: r.outputLanguage,
              onNativeReceipt: (receipt) =>
                this.store.nativeReceipt(callId, r.runId, details, receipt),
            }),
          (result) => ({
            actualModel: result.actualModel,
            requestId: result.requestId,
            usage: result.usage,
            ...(result.nativeReceipt ? { nativeReceipt: result.nativeReceipt } : {}),
            actualEffort: result.actualEffort ?? null,
            effortReceipt: result.actualEffort
              ? 'provider-attested'
              : 'requested-only; actual effort unknown',
            capabilityReceipt: result.capabilityReceipt ?? councilCapabilities(),
          }),
          (result) => {
            if (!model.responseIds.includes(result.actualModel))
              fail('MODEL_MISMATCH', 'Provider returned an unapproved model identity.');
            return parse(result.text);
          },
        );
      });
    try {
      let advice: JevAdvice | null = null;
      if (r.useJev) {
        if (!this.router) fail('JEV_UNAVAILABLE', 'Jev adapter is not registered.');
        advice = await use(async () => {
          const id = `${r.runId}/jev`;
          reserve(id, usdToMicro(this.settings.jev.reservationUsd));
          return account(
            id,
            true,
            {
              agent: 'jev',
              phase: 'jev',
              provider: 'openrouter',
              billing: 'api',
              requestedModel: this.settings.jev.model,
              requestedEffort: null,
            },
            () =>
              this.router!.advise(
                {
                  taskKind: r.kind,
                  agentCount: p.agents.length,
                  evidenceCount: r.evidence.length,
                  apiBudgetUsd: r.apiBudgetUsd,
                },
                signal,
              ),
            (result) => ({
              actualModel: result.model,
              requestId: result.requestId,
              choice: result.choice,
              confidence: result.confidence,
              model: result.model,
              costUsd: result.costUsd,
              usage: result.usage ?? {
                inputTokens: null,
                outputTokens: null,
                costUsd: result.costUsd,
              },
            }),
            (result) => result,
          );
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
        independent.map((a) =>
          call(
            a,
            'propose',
            proposerPrompt(a, {
              ...r,
              evidence: r.evidence.filter((e) =>
                ROLE_CONTRACTS[a.role].allowedEvidenceKinds.includes(e.kind),
              ),
            }),
            (text) => OpinionSchema.parse(JSON.parse(text)),
          ),
        ),
      );
      if (accountingFailure) throw accountingFailure;
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
      const critique = await call(
        skeptic,
        'critique',
        critiquePrompt(r, claims, opinions),
        (text) => OpinionSchema.parse(JSON.parse(text)),
        claims,
      );
      const verifier = p.agents.find((a) => a.role === 'verifier')!;
      const verification = await call(
        verifier,
        'verify',
        verifierPrompt(r, claims),
        (text) => VerificationSchema.parse(JSON.parse(text)),
        claims,
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
      const synthesis = await call(
        chair,
        'chair',
        chairPrompt(packet, r.outputLanguage),
        (text) => ChairSchema.parse(JSON.parse(text)),
        claims,
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
      error = accountingFailure ?? error;
      const code =
        error instanceof CouncilError
          ? error.code
          : signal.aborted
            ? 'CANCELLED'
            : 'PROVIDER_OR_SCHEMA_ERROR';
      // Do not persist arbitrary provider error bodies: they can contain credentials or prompt fragments.
      const result = {
        runId: r.runId,
        state: code === 'COST_OVERRUN' ? 'held' : signal.aborted ? 'cancelled' : 'held',
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
