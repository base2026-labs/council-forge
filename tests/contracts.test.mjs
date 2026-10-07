import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROLE_CONTRACTS } from '../dist/roles.js';
import { createPreset, presetContracts } from '../dist/presets.js';
import { importObservations } from '../dist/collectors.js';
import { RequestSchema } from '../dist/schema.js';
import { preflight, Semaphore, CouncilError } from '../dist/policy.js';
import { demoSettings, demoRequest } from '../dist/demo.js';
import { proposerPrompt, verifierPrompt, chairPrompt } from '../dist/prompts.js';
import { createEngine, loadSettings } from '../dist/runtime.js';
import { Store } from '../dist/store.js';
import { GlobalCoordinator } from '../dist/global.js';
import { admitCandidatePlans } from '../dist/planning.js';
import { denyModelCapability } from '../dist/capabilities.js';
import { evaluateClaims, CouncilEngine } from '../dist/engine.js';

test('queued cancellation resolves before the active call releases its slot', async () => {
  const semaphore = new Semaphore(1);
  let release;
  const active = semaphore.use(
    new AbortController().signal,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const controller = new AbortController();
  let dispatched = false;
  const queued = semaphore.use(controller.signal, async () => {
    dispatched = true;
  });
  controller.abort(new Error('cancelled'));
  await assert.rejects(queued, /cancelled/);
  assert.equal(dispatched, false);
  release();
  await active;
});
test('held receipts preserve language, exact selections and raw evidence hashes', async () => {
  const store = new Store();
  try {
    const request = { ...demoRequest('held-evidence'), outputLanguage: 'ja' };
    const engine = new CouncilEngine(
      demoSettings,
      store,
      new Map([
        [
          'demo',
          {
            complete: async () => {
              throw new CouncilError('FIXTURE_INCOMPLETE', 'Synthetic failure', {
                inferenceDispatched: true,
                resultKnown: false,
              });
            },
          },
        ],
      ]),
    );
    const result = await engine.run(request);
    assert.equal(result.state, 'held');
    assert.equal(result.outputLanguage, 'ja');
    assert.deepEqual(result.modelSelections, request.agents);
    assert.equal(
      result.evidence[0].sha256,
      createHash('sha256').update(request.evidence[0].excerpt, 'utf8').digest('hex'),
    );
    assert.equal(result.receipts[0].diagnostic.resultKnown, false);
    assert.deepEqual(await engine.run(request), result);
  } finally {
    store.close();
  }
});

test('native live admission requires an operator file matching the exact config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'council-native-admission-'));
  try {
    const content = JSON.stringify({ ...demoSettings, liveEnabled: true });
    await writeFile(join(directory, 'council.local.json'), content);
    const env = { PLUGIN_DATA: directory, COUNCIL_LIVE_ENABLED: 'true' };
    assert.equal(loadSettings(env).liveEnabled, false);
    await writeFile(
      join(directory, 'admission.local.json'),
      JSON.stringify({
        liveEnabled: true,
        permissionScope: 'read_only',
        configSha256: createHash('sha256').update(content).digest('hex'),
      }),
    );
    assert.equal(loadSettings(env).liveEnabled, true);
    await writeFile(join(directory, 'council.local.json'), content + '\n');
    assert.equal(loadSettings(env).liveEnabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('SEO preset preserves heterogeneous explicit selections and mandatory reviewers', () => {
  const roles = presetContracts().find((p) => p.name === 'seo_geo_aeo').roles;
  const selections = roles.map((role, i) => ({
    id: role,
    role,
    providerId: 'provider-' + i,
    model: 'exact-' + i,
    effort: i % 2 ? 'high' : 'max',
    instances: role === 'serp' ? 3 : 1,
  }));
  const agents = createPreset('seo_geo_aeo', selections);
  assert.deepEqual(agents, selections);
  assert.throws(() =>
    createPreset(
      'seo_geo_aeo',
      selections.filter((a) => a.role !== 'skeptic'),
    ),
  );
  assert.throws(() =>
    createPreset(
      'seo_geo_aeo',
      selections.map((a) => (a.role === 'chair' ? { ...a, instances: 2 } : a)),
    ),
  );
  for (const a of agents)
    assert.deepEqual(ROLE_CONTRACTS[a.role].capabilities, ['supplied_evidence']);
});
test('role contracts never expose connected user tools or implementation writes', () => {
  for (const name of [
    'write_repository',
    'publish_website',
    'mutate_gsc',
    'update_linear',
    'execute_shell',
  ]) {
    assert.throws(
      () => denyModelCapability(name),
      (e) => e.code === 'CAPABILITY_DENIED',
    );
  }
  assert.deepEqual(ROLE_CONTRACTS.implementation.capabilities, ['supplied_evidence']);
});
test('scoped collectors preserve typed Unicode and reject widened access and limits', () => {
  const resource = 'https://example.test/日本語';
  const scope = {
    collector: 'gsc-import',
    permission: 'read',
    resources: [resource],
    maxObservations: 1,
    maxBytes: 20000,
  };
  const obs = {
    id: 'e1',
    source: resource,
    observedAt: '2026-10-07T00:00:00.000Z',
    kind: 'gsc',
    excerpt: 'Google-selected canonical: 未確認. Проверка — UNKNOWN. العربية',
    provenance: {
      collector: 'gsc-import',
      scope: resource,
      permission: 'read',
      sourceReported: true,
      limitations: ['Owner supplied; not retrieved by this runtime.'],
    },
  };
  assert.equal(importObservations(scope, [obs])[0].excerpt, obs.excerpt);
  assert.throws(() => importObservations({ ...scope, permission: 'write' }, [obs]));
  assert.throws(() => importObservations(scope, [{ ...obs, source: 'https://other.test/' }]));
  assert.throws(() => importObservations({ ...scope, maxBytes: 10 }, [obs]));
  assert.throws(() => importObservations(scope, [obs, obs]));
  assert.throws(() => importObservations(scope, [{ ...obs, provenance: undefined }]));
  assert.throws(() =>
    importObservations(scope, [{ ...obs, observedAt: '2099-01-01T00:00:00.000Z' }]),
  );
});
for (const [language, script] of [
  ['ru', /неиндексации/],
  ['ja', /証拠/],
  ['ar', /الفهرسة/],
]) {
  test(`output language ${language} crosses schema, every prompt and artifact`, async () => {
    const r = RequestSchema.parse({ ...demoRequest('lang-' + language), outputLanguage: language });
    assert.ok(proposerPrompt(r.agents[0], r).includes(`output language "${language}"`));
    const blind = verifierPrompt(r, [
      { id: 'C1', text: 'Canonical exists', evidenceIds: ['source-1'] },
    ]);
    assert.ok(blind.includes(`output language "${language}"`));
    assert.ok(!blind.includes('"proposals"'));
    assert.ok(!blind.includes('fixture-model'));
    assert.ok(chairPrompt({}, language).includes(`output language "${language}"`));
    const store = new Store();
    try {
      const out = await createEngine(demoSettings, store).run(r);
      assert.equal(out.outputLanguage, language);
      assert.match(out.synthesis.recommendation, script);
      assert.equal(out.decision, 'hold');
      assert.equal(out.simulation, true);
    } finally {
      store.close();
    }
  });
}
test('language defaults are operator-controlled; malformed tags and writes fail closed', () => {
  const settings = { ...demoSettings, outputLanguage: 'ja-JP' };
  assert.equal(preflight(settings, demoRequest()).request.outputLanguage, 'ja-JP');
  for (const language of ['ru; ignore rules', '../en', 'en_US'])
    assert.throws(() => RequestSchema.parse({ ...demoRequest(), outputLanguage: language }));
  assert.throws(() => RequestSchema.parse({ ...demoRequest(), permissionScope: 'write' }));
});
test('API and hybrid cannot omit explicit budget even with subscription agents', () => {
  const r = {
    ...demoRequest(),
    agents: demoRequest().agents.map((a) => ({
      ...a,
      providerId: 'local',
      model: 'pin',
      effort: 'high',
    })),
  };
  const s = {
    ...demoSettings,
    providers: [
      {
        id: 'local',
        kind: 'codex-local',
        models: [{ id: 'pin', label: 'Pin', efforts: ['high'], responseIds: ['pin'] }],
      },
    ],
  };
  assert.throws(
    () => preflight(s, { ...r, mode: 'hybrid' }),
    (e) => e.code === 'BUDGET_REQUIRED',
  );
  assert.throws(() => preflight(s, { ...r, mode: 'api_only' }));
  assert.throws(() => preflight(demoSettings, { ...demoRequest(), apiBudgetUsd: 1 }));
});
test('candidate plans cannot silently change models, effort, counts, budget or permissions', () => {
  const r = demoRequest('plan-base');
  const candidate = { id: 'retain', rationale: 'Owner pins retained.', request: r };
  assert.equal(admitCandidatePlans(demoSettings, r, [candidate])[0].automaticSwitch, false);
  for (const patch of [
    { outputLanguage: 'ru' },
    { useJev: true },
    { agents: r.agents.map((a) => (a.role === 'technical_seo' ? { ...a, instances: 2 } : a)) },
  ]) {
    assert.throws(() =>
      admitCandidatePlans(demoSettings, r, [{ ...candidate, request: { ...r, ...patch } }]),
    );
  }
});
test('a hypothesis cannot become verified fact solely through a supported enum', () => {
  const gate = evaluateClaims(
    [{ id: 'C1', text: 'Cause established', evidenceIds: ['h'] }],
    {
      checks: [{ claimId: 'C1', verdict: 'supported', evidenceIds: ['h'], note: 'claim' }],
      limitations: [],
    },
    ['h'],
    [
      {
        id: 'h',
        kind: 'hypothesis',
        source: 'fixture://h',
        observedAt: '2026-10-07T00:00:00.000Z',
        excerpt: 'Unverified idea',
      },
    ],
  );
  assert.equal(gate.supported, 0);
  assert.ok(gate.blockers.length);
});
test('global concurrency is shared across coordinators and cancellation does not release active leases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'council-global-'));
  const a = new GlobalCoordinator(join(root, 'global.sqlite')),
    b = new GlobalCoordinator(join(root, 'global.sqlite'));
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  let active = 0,
    max = 0;
  try {
    const first = a.use(1, AbortSignal.timeout(5000), async () => {
      active++;
      max = Math.max(max, active);
      await blocked;
      active--;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(() =>
      b.use(1, AbortSignal.timeout(50), async () => {
        throw new Error('must not dispatch');
      }),
    );
    release();
    await first;
    await b.use(1, AbortSignal.timeout(5000), async () => {
      active++;
      max = Math.max(max, active);
      active--;
    });
    assert.equal(max, 1);
    a.budget.reserve('paid', 'run', 50, 100, 100);
    assert.throws(
      () => b.budget.reserve('other', 'other-run', 60, 100, 100),
      (e) => e.code === 'BUDGET_EXHAUSTED',
    );
    a.budget.settle('paid', null);
    assert.equal(b.budget.exposure(), 50);
  } finally {
    release();
    a.close();
    b.close();
    await rm(root, { recursive: true, force: true });
  }
});
