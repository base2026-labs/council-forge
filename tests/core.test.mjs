import test from 'node:test';
import assert from 'node:assert/strict';
import { demoSettings, demoRequest } from '../dist/demo.js';
import { preflight, hash, usdToMicro, reserveEstimate } from '../dist/policy.js';
import { SettingsSchema } from '../dist/schema.js';
import { Store } from '../dist/store.js';
import { CouncilEngine, evaluateClaims } from '../dist/engine.js';
import { MockProvider } from '../dist/adapters/mock.js';
import { verifierPrompt } from '../dist/prompts.js';
import { inspectHtml } from '../dist/seo.js';
const clone = (x) => structuredClone(x);
const request = () => demoRequest('test-run');
const live = () =>
  SettingsSchema.parse({
    ...demoSettings,
    liveEnabled: true,
    apiLifetimeLimitUsd: 2,
    maxRunApiUsd: 1,
    providers: [
      {
        ...demoSettings.providers[0],
        kind: 'openrouter',
        models: [
          {
            ...demoSettings.providers[0].models[0],
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 1,
            priceAsOf: new Date().toISOString(),
          },
        ],
      },
    ],
  });
const throws = (fn, code) => assert.throws(fn, (e) => e.code === code);
test('offline council expands researcher instances', () => {
  const r = request();
  r.agents[0].instances = 3;
  assert.equal(preflight(demoSettings, r).agents.length, 6);
});
test('subscription-only rejects any API agent', () =>
  throws(() => preflight(live(), request()), 'API_FORBIDDEN'));
test('subscription-only rejects Jev before an API call', () => {
  const r = request();
  r.useJev = true;
  throws(() => preflight(demoSettings, r), 'API_FORBIDDEN');
});
test('API-only rejects subscription agents', () => {
  const s = clone(demoSettings);
  s.providers[0].kind = 'codex-local';
  const r = request();
  r.mode = 'api_only';
  throws(() => preflight(s, r), 'SUBSCRIPTION_FORBIDDEN');
});
test('API routes require explicit budget', () => {
  const r = request();
  r.mode = 'api_only';
  throws(() => preflight(live(), r), 'BUDGET_REQUIRED');
});
test('owner maximum cannot be elevated in a request', () => {
  const r = request();
  r.apiBudgetUsd = 1;
  throws(() => preflight(demoSettings, r), 'BUDGET_NOT_ALLOWED');
});
test('duplicate IDs are rejected', () => {
  const r = request();
  r.agents[1].id = r.agents[0].id;
  throws(() => preflight(demoSettings, r), 'DUPLICATE_AGENT');
});
test('expanded IDs cannot collide', () => {
  const r = request();
  r.agents[0].instances = 2;
  r.agents[1].id = 'seo-1';
  throws(() => preflight(demoSettings, r), 'DUPLICATE_AGENT');
});
test('unknown models are not aliased', () => {
  const r = request();
  r.agents[0].model = 'Astra invented alias';
  throws(() => preflight(demoSettings, r), 'UNKNOWN_MODEL');
});
test('effort cannot be silently downgraded', () => {
  const r = request();
  r.agents[0].effort = 'xhigh';
  throws(() => preflight(demoSettings, r), 'UNSUPPORTED_EFFORT');
});
test('one verifier is required', () => {
  const r = request();
  r.agents[2].role = 'researcher';
  throws(() => preflight(demoSettings, r), 'REQUIRED_ROLE');
});
test('agent cap includes the chair and reviewers', () => {
  const s = { ...demoSettings, maxAgents: 4 };
  const r = request();
  r.agents[0].instances = 2;
  throws(() => preflight(s, r), 'AGENT_LIMIT');
});
test('factual task without evidence is needs_input', () => {
  const r = request();
  r.evidence = [];
  assert.equal(preflight(demoSettings, r).status, 'needs_input');
});
test('future evidence is rejected', () => {
  const r = request();
  r.evidence[0].observedAt = '2999-01-01T00:00:00.000Z';
  throws(() => preflight(demoSettings, r), 'FUTURE_EVIDENCE');
});
test('request hash ignores object key ordering', () =>
  assert.equal(hash({ a: 1, b: { y: 3, x: 2 } }), hash({ b: { x: 2, y: 3 }, a: 1 })));
test('negative and nonfinite costs are rejected', () => {
  throws(() => usdToMicro(-1), 'INVALID_COST');
  throws(() => usdToMicro(Infinity), 'INVALID_COST');
});
test('stale paid price snapshots fail closed', () =>
  throws(
    () =>
      reserveEstimate(
        { inputUsdPerMillion: 1, outputUsdPerMillion: 1, priceAsOf: '2020-01-01T00:00:00.000Z' },
        'x',
        100,
        24,
      ),
    'PRICE_STALE',
  ));
test('unknown pricing is not represented as free', () =>
  throws(() => reserveEstimate({}, 'x', 100, 24), 'PRICE_UNKNOWN'));
test('budget reservations are atomic and lifetime scoped', () => {
  const s = new Store();
  try {
    s.reserve('a', 'one', 60, 100, 100);
    throws(() => s.reserve('b', 'two', 50, 100, 100), 'BUDGET_EXHAUSTED');
    assert.equal(s.exposure(), 60);
  } finally {
    s.close();
  }
});
test('unknown API cost retains reservation', () => {
  const s = new Store();
  try {
    s.reserve('a', 'r', 60, 100, 100);
    s.settle('a', null);
    assert.equal(s.exposure(), 60);
    throws(() => s.reserve('a', 'r', 1, 100, 100), 'CALL_ALREADY_EXISTS');
  } finally {
    s.close();
  }
});
test('provider overrun stops the run and records the actual exposure', () => {
  const s = new Store();
  try {
    s.reserve('a', 'r', 60, 100, 100);
    throws(() => s.settle('a', 70), 'COST_OVERRUN');
    assert.equal(s.exposure(), 70);
  } finally {
    s.close();
  }
});
test('run-id payload mismatch is rejected', () => {
  const s = new Store();
  try {
    s.begin('r', 'hash-a');
    throws(() => s.begin('r', 'hash-b'), 'IDEMPOTENCY_CONFLICT');
  } finally {
    s.close();
  }
});
test('restart marks interrupted runs without replaying calls', () => {
  const s = new Store();
  try {
    s.begin('r', 'h');
    s.reserve('c', 'r', 20, 100, 100);
    s.recover();
    assert.equal(s.get('r').state, 'interrupted');
    assert.equal(s.exposure(), 20);
  } finally {
    s.close();
  }
});
test('missing semantic evidence cannot pass through valid JSON', () => {
  const gate = evaluateClaims(
    [{ id: 'C1', text: 'x', evidenceIds: ['E1'] }],
    {
      checks: [{ claimId: 'C1', verdict: 'unknown', evidenceIds: [], note: 'not established' }],
      limitations: [],
    },
    ['E1'],
  );
  assert.equal(gate.supported, 0);
  assert.ok(gate.blockers.length);
});
test('invented evidence IDs block acceptance', () => {
  const gate = evaluateClaims(
    [{ id: 'C1', text: 'x', evidenceIds: ['invented'] }],
    {
      checks: [{ claimId: 'C1', verdict: 'supported', evidenceIds: ['invented'], note: '' }],
      limitations: [],
    },
    ['real'],
  );
  assert.equal(gate.supported, 0);
});
test('duplicate verification checks block acceptance', () => {
  const check = { claimId: 'C1', verdict: 'supported', evidenceIds: ['E1'], note: '' };
  assert.ok(
    evaluateClaims(
      [{ id: 'C1', text: 'x', evidenceIds: ['E1'] }],
      { checks: [check, check], limitations: [] },
      ['E1'],
    ).blockers.length,
  );
});
test('blind verifier prompt excludes solver narrative', () => {
  const prompt = verifierPrompt(request(), [
    { id: 'C1', text: 'A fact', evidenceIds: ['source-1'] },
  ]);
  assert.ok(prompt.includes('A fact'));
  assert.ok(!prompt.includes('fixture-model'));
  assert.ok(!prompt.includes('DEMO ONLY:'));
});
test('offline council retains a major objection despite supported claims', async () => {
  const store = new Store();
  try {
    const engine = new CouncilEngine(demoSettings, store, new Map([['demo', new MockProvider()]]));
    const out = await engine.run(request());
    assert.equal(out.decision, 'hold');
    assert.equal(out.productionAuthorized, false);
    assert.equal(out.receipts.length, 4);
    assert.equal(out.apiExposureUsd, 0);
    assert.equal(out.simulation, true);
  } finally {
    store.close();
  }
});
test('same run ID and payload returns saved result without new calls', async () => {
  const store = new Store();
  let calls = 0;
  const mock = new MockProvider();
  try {
    const engine = new CouncilEngine(
      demoSettings,
      store,
      new Map([
        [
          'demo',
          {
            complete: async (x) => {
              calls++;
              return mock.complete(x);
            },
          },
        ],
      ]),
    );
    await engine.run(request());
    await engine.run(request());
    assert.equal(calls, 4);
  } finally {
    store.close();
  }
});
test('no evidence dispatches zero calls', async () => {
  const store = new Store();
  try {
    const engine = new CouncilEngine(
      demoSettings,
      store,
      new Map([['demo', { complete: async () => assert.fail('should not run') }]]),
    );
    const r = request();
    r.evidence = [];
    assert.equal((await engine.run(r)).state, 'needs_input');
  } finally {
    store.close();
  }
});
test('live calls require trusted enablement', async () => {
  const store = new Store();
  try {
    const s = live();
    s.liveEnabled = false;
    const r = request();
    r.mode = 'api_only';
    r.apiBudgetUsd = 1;
    const engine = new CouncilEngine(s, store, new Map());
    await assert.rejects(engine.run(r), (e) => e.code === 'LIVE_DISABLED');
  } finally {
    store.close();
  }
});
test('unknown paid cost is held without retries', async () => {
  const store = new Store();
  let calls = 0;
  try {
    const s = live(),
      r = request();
    r.mode = 'api_only';
    r.apiBudgetUsd = 1;
    const engine = new CouncilEngine(
      s,
      store,
      new Map([
        [
          'demo',
          {
            complete: async () => {
              calls++;
              return {
                text: '{}',
                actualModel: 'fixture-model',
                requestId: 'fixture',
                usage: { inputTokens: 1, outputTokens: 1, costUsd: null },
              };
            },
          },
        ],
      ]),
    );
    const out = await engine.run(r);
    assert.equal(out.errorCode, 'USAGE_UNKNOWN');
    assert.equal(calls, 1);
    assert.ok(out.apiExposureUsd > 0);
  } finally {
    store.close();
  }
});
test('global semaphore includes parallel councils', async () => {
  const store = new Store();
  let active = 0,
    max = 0;
  const mock = new MockProvider();
  try {
    const s = { ...demoSettings, maxConcurrency: 2 };
    const provider = {
      complete: async (input) => {
        active++;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 5));
        try {
          return await mock.complete(input);
        } finally {
          active--;
        }
      },
    };
    const engine = new CouncilEngine(s, store, new Map([['demo', provider]]));
    const a = request(),
      b = request();
    a.runId = 'a';
    b.runId = 'b';
    a.agents[0].instances = 4;
    b.agents[0].instances = 4;
    await Promise.all([engine.run(a), engine.run(b)]);
    assert.equal(max, 2);
  } finally {
    store.close();
  }
});
test('cancellation stops later stages', async () => {
  const store = new Store();
  let calls = 0;
  try {
    const provider = {
      complete: async (input) => {
        calls++;
        await new Promise((resolve, reject) => {
          input.signal.addEventListener('abort', () => reject(new Error('cancel')), { once: true });
        });
      },
    };
    const engine = new CouncilEngine(demoSettings, store, new Map([['demo', provider]]));
    const pending = engine.run(request());
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(engine.cancel('test-run'), true);
    const out = await pending;
    assert.equal(out.state, 'cancelled');
    assert.equal(calls, 1);
  } finally {
    store.close();
  }
});
test('HTML inspection parses markup, not escaped script text', () => {
  const out = inspectHtml(
    '<title>Hello &amp; World</title><script>let x="<link rel=canonical href=bad>"</script><link rel="alternate canonical" href="/real"><h1>Main</h1><img><img alt=""><script type="application/ld+json">{"@type":"Organization"}</script>',
    'https://example.test/',
  );
  assert.deepEqual(out.canonicals, ['/real']);
  assert.deepEqual(out.titles, ['Hello & World']);
  assert.equal(out.images.missingAlt, 1);
  assert.equal(out.images.emptyAlt, 1);
  assert.equal(out.jsonLd[0].validJson, true);
  assert.ok(out.notChecked.includes('Google-selected canonical'));
});
test('invalid JSON-LD is a syntax result, not schema validity', () => {
  const out = inspectHtml(
    '<script type="application/ld+json">{bad}</script>',
    'https://example.test/',
  );
  assert.equal(out.jsonLd[0].validJson, false);
  assert.ok(out.notChecked.includes('rich-result eligibility'));
});
