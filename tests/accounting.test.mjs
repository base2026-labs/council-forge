import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { demoSettings, demoRequest } from '../dist/demo.js';
import { SettingsSchema } from '../dist/schema.js';
import { Store } from '../dist/store.js';
import { CouncilEngine } from '../dist/engine.js';
import { OpenAICompatibleProvider } from '../dist/adapters/openrouter.js';
import { JevDecisionRouter } from '../dist/adapters/jev.js';
import { GlobalCoordinator } from '../dist/global.js';

// All transports are synthetic; no provider access or model turn is used.
process.env.COUNCIL_ACCOUNTING_FIXTURE_KEY = 'fixture-not-a-real-credential';
const keyEnv = 'COUNCIL_ACCOUNTING_FIXTURE_KEY';
const unknownUsage = { inputTokens: null, outputTokens: null, costUsd: null };
const usage = (cost = 0.002) => ({ prompt_tokens: 123, completion_tokens: 456, cost });
const reply = (cost = 0.002) => ({
  id: 'fixture-charge',
  model: 'fixture-model',
  choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
  usage: usage(cost),
});
async function fixture(fn, { concurrency = 1, instances = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'council-accounting-'));
  const localPath = join(root, 'local.sqlite');
  const globalPath = join(root, 'global.sqlite');
  const store = new Store(localPath);
  const global = new GlobalCoordinator(globalPath);
  const config = {
    ...demoSettings.providers[0],
    kind: 'openrouter',
    keyEnv,
    models: [
      {
        ...demoSettings.providers[0].models[0],
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 1,
        priceAsOf: new Date().toISOString(),
      },
    ],
  };
  const settings = SettingsSchema.parse({
    ...demoSettings,
    maxConcurrency: concurrency,
    liveEnabled: true,
    maxRunApiUsd: 1,
    apiLifetimeLimitUsd: 1,
    providers: [config],
    jev: { enabled: true, keyEnv, reservationUsd: 0.01 },
  });
  const request = demoRequest('accounting-fixture');
  request.mode = 'api_only';
  request.apiBudgetUsd = 1;
  request.agents = request.agents.map((a) => ({ ...a, effort: 'high' }));
  request.agents[0].instances = instances;
  const rows = (path) => {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      return db.prepare('SELECT * FROM calls ORDER BY id').all();
    } finally {
      db.close();
    }
  };
  try {
    await fn({
      store,
      global,
      config,
      settings,
      request,
      ledgers: () => [rows(localPath), rows(globalPath)],
      localPath,
      globalPath,
    });
  } finally {
    store.close();
    global.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function assertSettled(ctx, result, cost, count = 1) {
  assert.equal(result.decision, 'hold');
  assert.equal(result.apiExposureUsd, cost);
  assert.equal(ctx.store.exposure(ctx.request.runId), Math.round(cost * 1e6));
  assert.equal(ctx.global.budget.exposure(ctx.request.runId), Math.round(cost * 1e6));
  for (const rows of ctx.ledgers()) {
    assert.equal(rows.length, count);
    assert.ok(rows.every((row) => row.state === 'settled' && row.charged !== null));
  }
}
for (const [name, mutate, expected] of [
  [
    'incomplete generation',
    (out) => {
      out.choices[0].finish_reason = 'length';
    },
    'INCOMPLETE_GENERATION',
  ],
  [
    'tool call',
    (out) => {
      out.choices[0].message.tool_calls = [{ function: { name: 'write' } }];
    },
    'UNSUPPORTED_TOOL_CALL',
  ],
  [
    'malformed envelope',
    (out) => {
      out.choices = [];
    },
    'PROVIDER_OR_SCHEMA_ERROR',
  ],
  [
    'null content',
    (out) => {
      out.choices[0].message.content = null;
    },
    'PROVIDER_OR_SCHEMA_ERROR',
  ],
  [
    'invalid token field',
    (out) => {
      out.usage.prompt_tokens = -1;
    },
    'PROVIDER_OR_SCHEMA_ERROR',
  ],
  [
    'model mismatch',
    (out) => {
      out.model = 'unapproved-model';
    },
    'MODEL_MISMATCH',
  ],
  [
    'invalid JSON output',
    (out) => {
      out.choices[0].message.content = 'private-output-fragment';
    },
    'PROVIDER_OR_SCHEMA_ERROR',
  ],
  ['invalid opinion schema', () => {}, 'PROVIDER_OR_SCHEMA_ERROR'],
])
  test(`charged OpenRouter ${name} stays HOLD with both ledgers and a receipt`, () =>
    fixture(async (ctx) => {
      let calls = 0;
      const out = reply();
      mutate(out);
      const provider = new OpenAICompatibleProvider(ctx.config, async () => {
        calls++;
        return Response.json(out);
      });
      const engine = new CouncilEngine(
        ctx.settings,
        ctx.store,
        new Map([['demo', provider]]),
        undefined,
        ctx.global,
      );
      const result = await engine.run(ctx.request);
      assertSettled(ctx, result, 0.002);
      assert.equal(result.errorCode, expected);
      assert.equal(result.receipts.length, 1);
      const receipt = result.receipts[0];
      assert.equal(receipt.callId, 'accounting-fixture/propose/seo');
      assert.equal(receipt.requestId, 'fixture-charge');
      assert.equal(receipt.actualModel, out.model);
      assert.equal(receipt.state, 'held');
      assert.equal(receipt.usage.costUsd, 0.002);
      assert.equal(receipt.usage.inputTokens, name === 'invalid token field' ? null : 123);
      assert.equal(receipt.usage.outputTokens, 456);
      assert.ok(!JSON.stringify(result).includes('private-output-fragment'));
      assert.ok(
        ctx.store
          .events(ctx.request.runId)
          .some(
            (event) =>
              event.type === 'agent_held' && JSON.parse(event.data).requestId === 'fixture-charge',
          ),
      );
      assert.deepEqual(await engine.run(ctx.request), result);
      assert.equal(calls, 1);
    }));
test('HTTP rejection retains only sanitized reported identity and usage', () =>
  fixture(async (ctx) => {
    const provider = new OpenAICompatibleProvider(ctx.config, async () =>
      Response.json(
        {
          ...reply(),
          error: { message: 'private-provider-body' },
        },
        { status: 422 },
      ),
    );
    const engine = new CouncilEngine(
      ctx.settings,
      ctx.store,
      new Map([['demo', provider]]),
      undefined,
      ctx.global,
    );
    const result = await engine.run(ctx.request);
    assertSettled(ctx, result, 0.002);
    assert.equal(result.errorCode, 'HTTP_422');
    assert.equal(result.receipts[0].requestId, 'fixture-charge');
    assert.ok(!JSON.stringify(result).includes('private-provider-body'));
  }));
for (const cost of [undefined, -1, '0.002'])
  test(`unknown/invalid cost ${String(cost)} retains reservation and usable fields`, () =>
    fixture(async (ctx) => {
      const out = reply();
      out.usage.cost = cost;
      out.choices[0].finish_reason = 'length';
      const provider = new OpenAICompatibleProvider(ctx.config, async () => Response.json(out));
      const engine = new CouncilEngine(
        ctx.settings,
        ctx.store,
        new Map([['demo', provider]]),
        undefined,
        ctx.global,
      );
      const result = await engine.run(ctx.request);
      assert.equal(result.decision, 'hold');
      assert.equal(result.receipts[0].requestId, 'fixture-charge');
      assert.equal(result.receipts[0].usage.costUsd, null);
      assert.equal(result.receipts[0].usage.inputTokens, 123);
      for (const rows of ctx.ledgers()) {
        assert.equal(rows[0].state, 'unknown');
        assert.equal(rows[0].charged, null);
        assert.ok(rows[0].reserved > 0);
      }
    }));
const jevReply = (cost) => ({
  id: 'fixture-jev',
  model: 'typesafe/jev-1.13-20260917',
  usage: usage(cost),
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
});
for (const [name, mutate, expected] of [
  [
    'schema',
    (out) => {
      out.answers = {};
    },
    'PROVIDER_OR_SCHEMA_ERROR',
  ],
  [
    'choice',
    (out) => {
      out.answers.next_action.choice = 'change-model';
    },
    'PROVIDER_OR_SCHEMA_ERROR',
  ],
  [
    'model',
    (out) => {
      out.model = 'other-model';
    },
    'JEV_MODEL_MISMATCH',
  ],
  [
    'distribution',
    (out) => {
      out.answers.next_action.probabilities.run_current_council = 0.1;
    },
    'JEV_INVALID_DISTRIBUTION',
  ],
])
  test(`Jev ${name} rejection preserves its charged receipt without model dispatch`, () =>
    fixture(async (ctx) => {
      let calls = 0;
      const out = jevReply(0.002);
      mutate(out);
      ctx.request.useJev = true;
      const router = new JevDecisionRouter(ctx.settings.jev, async () => {
        calls++;
        return Response.json(out);
      });
      const engine = new CouncilEngine(
        ctx.settings,
        ctx.store,
        new Map([
          [
            'demo',
            {
              complete: async () => assert.fail('No council call after rejected Jev'),
            },
          ],
        ]),
        router,
        ctx.global,
      );
      const result = await engine.run(ctx.request);
      assertSettled(ctx, result, 0.002);
      assert.equal(result.errorCode, expected);
      assert.equal(result.receipts.length, 1);
      assert.equal(result.receipts[0].callId, 'accounting-fixture/jev');
      assert.equal(result.receipts[0].requestId, 'fixture-jev');
      assert.equal(result.receipts[0].usage.costUsd, 0.002);
      assert.deepEqual(await engine.run(ctx.request), result);
      assert.equal(calls, 1);
    }));
for (const incomplete of [false, true])
  test(`serial overrun (${incomplete ? 'incomplete' : 'stop'}) blocks second transport and preserves charge`, () =>
    fixture(
      async (ctx) => {
        let calls = 0;
        const provider = new OpenAICompatibleProvider(ctx.config, async () => {
          calls++;
          const out = reply(0.75);
          if (incomplete) out.choices[0].finish_reason = 'length';
          return Response.json(out);
        });
        const engine = new CouncilEngine(
          ctx.settings,
          ctx.store,
          new Map([['demo', provider]]),
          undefined,
          ctx.global,
        );
        const result = await engine.run(ctx.request);
        assert.equal(calls, 1);
        assertSettled(ctx, result, 0.75);
        assert.equal(result.errorCode, 'COST_OVERRUN');
        assert.equal(result.receipts.length, 1);
        assert.equal(result.receipts[0].requestId, 'fixture-charge');
        assert.equal(result.receipts[0].usage.costUsd, 0.75);
        if (incomplete) assert.equal(result.receipts[0].responseErrorCode, 'INCOMPLETE_GENERATION');
        assert.equal(result.receipts[0].errorCode, 'COST_OVERRUN');
        assert.deepEqual(await engine.run(ctx.request), result);
        assert.equal(calls, 1);
      },
      { instances: 2 },
    ));
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
test('concurrent overrun drains both in-flight responses and admits no queued third call', () =>
  fixture(
    async (ctx) => {
      const started = deferred(),
        first = deferred(),
        second = deferred();
      let calls = 0;
      const provider = new OpenAICompatibleProvider(ctx.config, async (_url, init) => {
        const n = ++calls;
        if (n === 2) started.resolve();
        assert.ok(n <= 2, 'Third transport must remain queued');
        const controllerSignal = init.signal;
        await (n === 1 ? first.promise : second.promise);
        assert.equal(controllerSignal.aborted, false, 'Overrun must preserve in-flight transport');
        return Response.json({ ...reply(n === 1 ? 0.75 : 0.002), id: `inflight-${n}` });
      });
      const engine = new CouncilEngine(
        ctx.settings,
        ctx.store,
        new Map([['demo', provider]]),
        undefined,
        ctx.global,
      );
      const pending = engine.run(ctx.request);
      await started.promise;
      first.resolve();
      await new Promise((r) => setImmediate(r));
      const callsAfterFirst = calls;
      second.resolve();
      const result = await pending;
      assert.equal(callsAfterFirst, 2);
      assertSettled(ctx, result, 0.752, 2);
      assert.equal(result.errorCode, 'COST_OVERRUN');
      assert.equal(result.receipts.length, 2);
      assert.deepEqual(result.receipts.map((r) => r.requestId).sort(), [
        'inflight-1',
        'inflight-2',
      ]);
      assert.deepEqual(await engine.run(ctx.request), result);
      assert.equal(calls, 2);
    },
    { concurrency: 2, instances: 3 },
  ));
test('cancellation drains a known in-flight charge and keeps an interrupted charge UNKNOWN without replay', () =>
  fixture(
    async (ctx) => {
      const started = deferred(),
        first = deferred(),
        second = deferred();
      let calls = 0;
      const provider = new OpenAICompatibleProvider(ctx.config, async () => {
        const n = ++calls;
        if (n === 2) started.resolve();
        assert.ok(n <= 2);
        await (n === 1 ? first.promise : second.promise);
        if (n === 2) throw new Error('private-transport-failure');
        return Response.json(reply());
      });
      const engine = new CouncilEngine(
        ctx.settings,
        ctx.store,
        new Map([['demo', provider]]),
        undefined,
        ctx.global,
      );
      const pending = engine.run(ctx.request);
      await started.promise;
      assert.equal(engine.cancel(ctx.request.runId), true);
      first.resolve();
      second.resolve();
      const result = await pending;
      assert.equal(result.state, 'cancelled');
      assert.equal(result.decision, 'hold');
      assert.equal(result.receipts.length, 2);
      assert.equal(calls, 2);
      assert.equal(
        result.receipts.find((r) => r.requestId === 'fixture-charge').usage.costUsd,
        0.002,
      );
      assert.deepEqual(
        result.receipts.find((r) => r.requestId !== 'fixture-charge').usage,
        unknownUsage,
      );
      for (const rows of ctx.ledgers()) {
        assert.equal(rows.length, 2);
        assert.equal(rows[0].charged, 2000);
        assert.equal(rows[1].charged, null);
        assert.equal(rows[1].state, 'unknown');
      }
      assert.equal(
        ctx.store.exposure(ctx.request.runId),
        ctx.global.budget.exposure(ctx.request.runId),
      );
      ctx.store.recover();
      ctx.global.budget.recover();
      assert.deepEqual(await engine.run(ctx.request), result);
      assert.equal(calls, 2);
      assert.ok(!JSON.stringify(result).includes('private-transport-failure'));
    },
    { concurrency: 2, instances: 3 },
  ));

test('Jev overrun retains its receipt and starts no council transport', () =>
  fixture(async (ctx) => {
    ctx.request.useJev = true;
    let calls = 0;
    const router = new JevDecisionRouter(ctx.settings.jev, async () => {
      calls++;
      return Response.json(jevReply(0.75));
    });
    const engine = new CouncilEngine(
      ctx.settings,
      ctx.store,
      new Map([
        [
          'demo',
          {
            complete: async () => assert.fail('No model dispatch after Jev overrun'),
          },
        ],
      ]),
      router,
      ctx.global,
    );
    const result = await engine.run(ctx.request);
    assertSettled(ctx, result, 0.75);
    assert.equal(result.errorCode, 'COST_OVERRUN');
    assert.equal(result.receipts[0].requestId, 'fixture-jev');
    assert.equal(result.receipts[0].usage.costUsd, 0.75);
    assert.deepEqual(await engine.run(ctx.request), result);
    assert.equal(calls, 1);
  }));
test('Jev HTTP rejection preserves a known charge; missing cost remains UNKNOWN', async () => {
  for (const cost of [0.002, undefined])
    await fixture(async (ctx) => {
      ctx.request.useJev = true;
      const router = new JevDecisionRouter(ctx.settings.jev, async () => {
        const out = jevReply(cost);
        if (cost === undefined) delete out.usage.cost;
        return Response.json({ ...out, error: { message: 'private-jev-body' } }, { status: 422 });
      });
      const engine = new CouncilEngine(ctx.settings, ctx.store, new Map(), router, ctx.global);
      const result = await engine.run(ctx.request);
      assert.equal(result.decision, 'hold');
      assert.equal(result.receipts[0].requestId, 'fixture-jev');
      assert.equal(result.receipts[0].usage.costUsd, cost ?? null);
      if (cost !== undefined) assertSettled(ctx, result, cost);
      else
        for (const rows of ctx.ledgers()) {
          assert.equal(rows[0].state, 'unknown');
          assert.equal(rows[0].charged, null);
        }
      assert.ok(!JSON.stringify(result).includes('private-jev-body'));
    });
});
test('unknown cost stops serial queued admission without replacing it with zero', () =>
  fixture(
    async (ctx) => {
      let calls = 0;
      const provider = new OpenAICompatibleProvider(ctx.config, async () => {
        calls++;
        const out = reply();
        delete out.usage.cost;
        return Response.json(out);
      });
      const engine = new CouncilEngine(
        ctx.settings,
        ctx.store,
        new Map([['demo', provider]]),
        undefined,
        ctx.global,
      );
      const result = await engine.run(ctx.request);
      assert.equal(result.errorCode, 'USAGE_UNKNOWN');
      assert.equal(calls, 1);
      assert.equal(result.receipts[0].usage.costUsd, null);
      for (const rows of ctx.ledgers()) {
        assert.equal(rows.length, 1);
        assert.equal(rows[0].state, 'unknown');
      }
      assert.deepEqual(await engine.run(ctx.request), result);
      assert.equal(calls, 1);
    },
    { instances: 2 },
  ));
test('a later in-flight overrun takes precedence over an earlier schema rejection', () =>
  fixture(
    async (ctx) => {
      let calls = 0;
      const provider = new OpenAICompatibleProvider(ctx.config, async () => {
        const n = ++calls;
        const out = reply(n === 1 ? 0.002 : 0.75);
        if (n === 1) out.choices[0].finish_reason = 'length';
        else await new Promise((r) => setImmediate(r));
        out.id = `rejected-inflight-${n}`;
        return Response.json(out);
      });
      const engine = new CouncilEngine(
        ctx.settings,
        ctx.store,
        new Map([['demo', provider]]),
        undefined,
        ctx.global,
      );
      const result = await engine.run(ctx.request);
      assertSettled(ctx, result, 0.752, 2);
      assert.equal(result.errorCode, 'COST_OVERRUN');
      assert.equal(result.receipts.length, 2);
      assert.equal(calls, 2);
      assert.equal(result.receipts[0].responseErrorCode, 'INCOMPLETE_GENERATION');
    },
    { concurrency: 2, instances: 2 },
  ));
test('zero cost is known; unsafe identities and private fields never enter accounting receipts', () =>
  fixture(async (ctx) => {
    const out = reply(0);
    out.id = 'private\nidentity';
    out.model = 'invalid\nmodel';
    out.usage.prompt_tokens = 'private-token-field';
    out.secret = 'private-body-fragment';
    const provider = new OpenAICompatibleProvider(ctx.config, async () => Response.json(out));
    const engine = new CouncilEngine(
      ctx.settings,
      ctx.store,
      new Map([['demo', provider]]),
      undefined,
      ctx.global,
    );
    const result = await engine.run(ctx.request);
    assertSettled(ctx, result, 0);
    assert.equal(result.receipts[0].requestId, null);
    assert.equal(result.receipts[0].actualModel, null);
    assert.equal(result.receipts[0].usage.inputTokens, null);
    assert.equal(result.receipts[0].usage.outputTokens, 456);
    assert.ok(!JSON.stringify(result.receipts).includes('private'));
  }));
test('process interruption after dispatch recovers both UNKNOWN ledgers without replay', () =>
  fixture(
    async (ctx) => {
      const url = (file) => new URL(`../dist/${file}.js`, import.meta.url).href;
      const source = `
    import { Store } from ${JSON.stringify(url('store'))};
    import { GlobalCoordinator } from ${JSON.stringify(url('global'))};
    import { CouncilEngine } from ${JSON.stringify(url('engine'))};
    const store = new Store(process.argv[1]);
    const global = new GlobalCoordinator(process.argv[2]);
    const settings = JSON.parse(process.argv[3]), request = JSON.parse(process.argv[4]);
    const provider = { complete: async () => {
      process.send('fixture-dispatched'); await new Promise(() => {});
    } };
    await new CouncilEngine(settings, store, new Map([['demo', provider]]), undefined, global).run(request);
  `;
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          source,
          ctx.localPath,
          ctx.globalPath,
          JSON.stringify(ctx.settings),
          JSON.stringify(ctx.request),
        ],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
      );
      const exited = once(child, 'exit');
      try {
        const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
        assert.equal(message, 'fixture-dispatched');
      } finally {
        child.kill('SIGKILL');
        await exited;
      }
      ctx.store.recover();
      ctx.global.budget.recover();
      const before = ctx.store.exposure(ctx.request.runId);
      assert.ok(before > 0);
      for (const rows of ctx.ledgers()) {
        assert.equal(rows.length, 1);
        assert.equal(rows[0].state, 'unknown');
        assert.equal(rows[0].charged, null);
      }
      const engine = new CouncilEngine(
        ctx.settings,
        ctx.store,
        new Map([
          [
            'demo',
            {
              complete: async () => assert.fail('Interrupted invocation must not be replayed'),
            },
          ],
        ]),
        undefined,
        ctx.global,
      );
      const result = await engine.run(ctx.request);
      assert.equal(result.state, 'interrupted');
      assert.equal(ctx.store.exposure(ctx.request.runId), before);
      assert.equal(ctx.global.budget.exposure(ctx.request.runId), before);
      assert.equal(
        ctx.store.events(ctx.request.runId).filter((e) => e.type === 'agent_started').length,
        1,
      );
    },
    { instances: 2 },
  ));
