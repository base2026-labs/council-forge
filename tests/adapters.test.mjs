import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenAICompatibleProvider, discoverOpenRouter } from '../dist/adapters/openrouter.js';
import { JevDecisionRouter } from '../dist/adapters/jev.js';
import { assertSubscriptionAccount } from '../dist/adapters/codex-local.js';
import { httpsEndpoint } from '../dist/adapters/http.js';
import { ProviderSchema } from '../dist/schema.js';
import { demoRequest } from '../dist/demo.js';
process.env.COUNCIL_TEST_KEY = 'unit-test-placeholder-not-a-credential';
const config = () =>
  ProviderSchema.parse({
    id: 'p',
    kind: 'openrouter',
    keyEnv: 'COUNCIL_TEST_KEY',
    models: [
      {
        id: 'fixture-model',
        label: 'fixture',
        efforts: ['high'],
        responseIds: ['fixture-model'],
        jsonMode: true,
      },
    ],
  });
const input = () => ({
  agent: { ...demoRequest().agents[0], effort: 'high' },
  phase: 'propose',
  prompt: 'Test data',
  maxOutputTokens: 1000,
  signal: AbortSignal.timeout(2000),
  evidence: [],
  claims: [],
});
const result = (extra = {}) => ({
  model: 'fixture-model',
  id: 'fixture-response',
  choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
  usage: { cost: 0.00001, prompt_tokens: 10, completion_tokens: 2 },
  ...extra,
});
test('OpenRouter sends a pinned model with no provider fallback', async () => {
  let seen;
  const adapter = new OpenAICompatibleProvider(config(), async (url, init) => {
    seen = { url: String(url), ...init };
    return Response.json(result());
  });
  const out = await adapter.complete(input());
  const body = JSON.parse(seen.body);
  assert.equal(body.model, 'fixture-model');
  assert.equal(body.provider.allow_fallbacks, false);
  assert.equal(body.provider.require_parameters, true);
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(seen.redirect, 'error');
  assert.equal(out.usage.costUsd, 0.00001);
});
test('unexpected generation truncation is not a success', async () => {
  const adapter = new OpenAICompatibleProvider(config(), async () =>
    Response.json(result({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })),
  );
  await assert.rejects(adapter.complete(input()), (e) => e.code === 'INCOMPLETE_GENERATION');
});
test('HTTP errors are not retried or echoed', async () => {
  let n = 0;
  const adapter = new OpenAICompatibleProvider(config(), async () => {
    n++;
    return new Response('sensitive provider error', { status: 429 });
  });
  await assert.rejects(
    adapter.complete(input()),
    (e) => e.code === 'HTTP_429' && !e.message.includes('sensitive'),
  );
  assert.equal(n, 1);
});
test('missing usage is not zero-cost usage', async () => {
  const adapter = new OpenAICompatibleProvider(config(), async () =>
    Response.json(result({ usage: undefined })),
  );
  assert.equal((await adapter.complete(input())).usage.costUsd, null);
});
test('external provider redirects are forbidden', () =>
  assert.throws(
    () => httpsEndpoint('http://example.test', 'chat/completions'),
    (e) => e.code === 'UNSAFE_ENDPOINT',
  ));
test('provider credentials cannot be embedded in URL', () =>
  assert.throws(
    () => httpsEndpoint('https://user:pass@example.test', 'chat/completions'),
    (e) => e.code === 'UNSAFE_ENDPOINT',
  ));
test('model catalogue discovery does not claim account eligibility', async () => {
  const models = await discoverOpenRouter(async () =>
    Response.json({
      data: [
        {
          id: 'a',
          name: 'A',
          pricing: { prompt: '0.000001', completion: '0.000002' },
          supported_parameters: ['reasoning'],
        },
      ],
    }),
  );
  assert.equal(models[0].inputUsdPerMillion, 1);
  assert.equal(models[0].outputUsdPerMillion, 2);
  assert.ok(!('entitled' in models[0]));
});
const jevConfig = {
  enabled: true,
  model: 'typesafe/jev-1.13-20260917',
  keyEnv: 'COUNCIL_TEST_KEY',
  confidenceThreshold: 0.9,
  reservationUsd: 0.01,
};
const metrics = { taskKind: 'seo_audit', agentCount: 4, evidenceCount: 1, apiBudgetUsd: 0.1 };
const jevReply = () => ({
  model: jevConfig.model,
  id: 'fixture-jev',
  answers: {
    next_action: {
      type: 'choice',
      choice: 'run_current_council',
      confidence: 0.95,
      probabilities: {
        run_current_council: 0.95,
        request_more_evidence: 0.03,
        request_deeper_review: 0.02,
      },
    },
  },
  usage: { cost: 0.00001 },
});
test('Jev uses Decisions API and aggregate-only state', async () => {
  let seen;
  const router = new JevDecisionRouter(jevConfig, async (url, init) => {
    seen = { url: String(url), body: JSON.parse(init.body) };
    return Response.json(jevReply());
  });
  const result = await router.advise(metrics, AbortSignal.timeout(1000));
  assert.equal(seen.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.deepEqual(seen.body.state, metrics);
  assert.equal(seen.body.questions.next_action.type, 'choice');
  assert.equal(result.choice, 'run_current_council');
});
test('Jev rejects added private fields before transport', async () => {
  let calls = 0;
  const router = new JevDecisionRouter(jevConfig, async () => {
    calls++;
    return Response.json(jevReply());
  });
  await assert.rejects(
    router.advise({ ...metrics, rawTask: 'private customer text' }, AbortSignal.timeout(1000)),
  );
  assert.equal(calls, 0);
});
test('Jev rejects unknown decision choices', async () => {
  const out = jevReply();
  out.answers.next_action.choice = 'use_unapproved_model';
  const router = new JevDecisionRouter(jevConfig, async () => Response.json(out));
  await assert.rejects(router.advise(metrics, AbortSignal.timeout(1000)));
});
test('Jev refuses a different model version', async () => {
  const out = jevReply();
  out.model = 'other-model';
  const router = new JevDecisionRouter(jevConfig, async () => Response.json(out));
  await assert.rejects(
    router.advise(metrics, AbortSignal.timeout(1000)),
    (e) => e.code === 'JEV_MODEL_MISMATCH',
  );
});
test('subscription adapter rejects API key authentication', () =>
  assert.throws(
    () => assertSubscriptionAccount({ account: { type: 'apiKey' }, requiresOpenaiAuth: true }),
    (e) => e.code === 'SUBSCRIPTION_AUTH_REQUIRED',
  ));
test('subscription adapter rejects anonymous and provider-mismatched accounts', () => {
  assert.throws(() => assertSubscriptionAccount({ account: null, requiresOpenaiAuth: true }));
  assert.throws(() =>
    assertSubscriptionAccount({ account: { type: 'chatgpt' }, requiresOpenaiAuth: false }),
  );
});
test('managed ChatGPT account is eligible for further preflight, not proof of entitlement', () =>
  assert.doesNotThrow(() =>
    assertSubscriptionAccount({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true }),
  ));
