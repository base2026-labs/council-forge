import type { Provider, Invocation, Completion } from '../provider.ts';
export class MockProvider implements Provider {
  async complete(input: Invocation): Promise<Completion> {
    input.signal.throwIfAborted();
    let answer: unknown;
    if (input.phase === 'propose')
      answer = {
        summary: 'DEMO ONLY: a canonical tag is visible in the supplied HTML.',
        claims: [
          {
            text: 'The supplied source HTML contains a canonical link.',
            evidenceIds: input.evidence.slice(0, 1).map((e) => e.id),
          },
        ],
        objections: [],
      };
    else if (input.phase === 'critique')
      answer = {
        summary: 'DEMO ONLY: do not confuse the declared canonical with Google-selected canonical.',
        claims: [],
        objections: [
          {
            text: 'The cause of non-indexation is not established by source HTML. A current URL Inspection response is missing.',
            severity: 'major',
          },
        ],
      };
    else if (input.phase === 'verify')
      answer = {
        checks: input.claims.map((c) => ({
          claimId: c.id,
          verdict: 'supported',
          evidenceIds: c.evidenceIds,
          note: 'DEMO ONLY: deterministic fixture response, not a model judgment.',
        })),
        limitations: ['Fixture data; no live website or model has been contacted.'],
      };
    else
      answer = {
        recommendation:
          'HOLD the causal conclusion; obtain URL Inspection evidence before proposing an indexing fix.',
        reasons: ['An unresolved major objection remains.'],
        nextActions: [
          'Collect Google-selected canonical and indexing status, keeping this read-only.',
        ],
      };
    const localized: Record<string, string> = {
      ru: 'ТЕСТОВЫЙ ПРИМЕР: причина неиндексации не доказана. Нужны данные URL Inspection.',
      ja: 'オフライン例：インデックス未登録の原因は未確認です。URL Inspection の証拠が必要です。',
      ar: 'مثال دون اتصال: سبب عدم الفهرسة غير مثبت. يلزم دليل من فحص عنوان URL.',
    };
    const translation = localized[(input.outputLanguage ?? 'en').split('-')[0]!];
    if (translation) {
      const out = answer as Record<string, unknown>;
      if (input.phase === 'propose') {
        out.summary = translation;
        out.claims = [
          { text: translation, evidenceIds: input.evidence.slice(0, 1).map((e) => e.id) },
        ];
      }
      if (input.phase === 'critique') {
        out.summary = translation;
        out.objections = [{ text: translation, severity: 'major' }];
      }
      if (input.phase === 'verify') {
        out.checks = input.claims.map((c) => ({
          claimId: c.id,
          verdict: 'unknown',
          evidenceIds: c.evidenceIds,
          note: translation,
        }));
        out.limitations = [translation];
      }
      if (input.phase === 'chair') {
        out.recommendation = translation;
        out.reasons = [translation];
        out.nextActions = [translation];
      }
    }
    return {
      text: JSON.stringify(answer),
      actualModel: input.agent.model,
      requestId: 'fixture-only',
      usage: { inputTokens: null, outputTokens: null, costUsd: 0 },
    };
  }
}
