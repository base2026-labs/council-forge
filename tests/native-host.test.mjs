import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runInNewContext } from 'node:vm';
import { CodexLocalProvider } from '../dist/adapters/codex-local.js';
import { loadSettings } from '../dist/runtime.js';
import { demoSettings, demoRequest } from '../dist/demo.js';
import { GlobalCoordinator } from '../dist/global.js';

const digest = (value) => createHash('sha256').update(value).digest('hex');
test('passive global discovery preserves legacy database bytes and reservation state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-passive-global-'));
  const path = join(root, 'legacy.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE leases (id INTEGER PRIMARY KEY, pid INTEGER NOT NULL, cap INTEGER NOT NULL);
    CREATE TABLE calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER, state TEXT NOT NULL);
    INSERT INTO calls VALUES ('old-unknown', 'old-run', 12000, NULL, 'unknown');
  `);
  legacy.close();
  const before = digest(await readFile(path));
  let coordinator;
  try {
    coordinator = new GlobalCoordinator(path);
    assert.equal(coordinator.path, path);
    coordinator.close();
    coordinator = undefined;
    assert.equal(digest(await readFile(path)), before);
    coordinator = new GlobalCoordinator(path);
    assert.equal(coordinator.budget.exposure(), 12000);
    coordinator.close();
    coordinator = undefined;
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(
        { ...db.prepare('SELECT * FROM calls').get() },
        {
          id: 'old-unknown',
          run_id: 'old-run',
          reserved: 12000,
          charged: null,
          state: 'unknown',
        },
      );
      assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='native_invocations'").get());
    } finally {
      db.close();
    }
  } finally {
    coordinator?.close();
    await rm(root, { recursive: true, force: true });
  }
});
for (const [mode, known] of [
  ['failed-first', true],
  ['interrupted', true],
  ['partial-completed', true],
  ['final-exit', false],
  ['partial-exit', false],
  ['ack-completed-only', false],
])
  test(
    'native terminal knowledge is distinct from accepted output: ' + mode,
    { skip: process.platform === 'win32' },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'native-host-map-'));
      try {
        const executable = join(root, 'server.mjs');
        await writeFile(
          executable,
          await readFile(new URL('./fixtures/native-app-server.mjs', import.meta.url)),
          { mode: 0o700 },
        );
        await writeFile(join(root, 'fixture-mode'), mode);
        const agent = { ...demoRequest().agents[0], effort: 'high' };
        await assert.rejects(
          new CodexLocalProvider({
            ...demoSettings.providers[0],
            kind: 'codex-local',
            codexHome: root,
            codexExecutable: executable,
          }).complete({
            agent,
            phase: 'propose',
            prompt: 'offline fixture',
            evidence: [],
            claims: [],
            signal: AbortSignal.timeout(5000),
            maxOutputTokens: 256,
          }),
          (error) => {
            assert.equal(error.diagnostic.resultKnown, known);
            assert.equal(error.diagnostic.inferenceDispatched, true);
            assert.equal(error.receipt.requestId, null);
            assert.equal(error.receipt.nativeReceipt.threadId, 'native-thread');
            return true;
          },
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

test('operator namespace changes invalidate native admission without altering legacy state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-host-namespace-'));
  try {
    const content = JSON.stringify({ ...demoSettings, liveEnabled: true });
    await writeFile(join(root, 'council.local.json'), content);
    const env = { PLUGIN_DATA: root };
    await writeFile(
      join(root, 'admission.local.json'),
      JSON.stringify({
        liveEnabled: true,
        permissionScope: 'read_only',
        configSha256: digest(content),
      }),
    );
    assert.equal(loadSettings(env).liveEnabled, true);
    const runtime = JSON.stringify({ stateNamespace: 'native-review' });
    await writeFile(join(root, 'runtime.local.json'), runtime);
    assert.equal(loadSettings(env).liveEnabled, false);
    await writeFile(
      join(root, 'admission.local.json'),
      JSON.stringify({
        liveEnabled: true,
        permissionScope: 'read_only',
        configSha256: digest(content),
        runtimeSha256: digest(runtime),
        runId: 'distinct',
        requestSha256: digest('request'),
      }),
    );
    assert.equal(loadSettings(env).liveEnabled, true);
    await writeFile(join(root, 'runtime.local.json'), runtime + '\n');
    assert.equal(loadSettings(env).liveEnabled, false);
    await writeFile(
      join(root, 'runtime.local.json'),
      JSON.stringify({ stateNamespace: '../escape' }),
    );
    assert.throws(() => loadSettings(env));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function roomFixture(status) {
  class Element {
    value = '';
    disabled = true;
    children = [];
    textContent = '';
    replaceChildren() {
      this.children = [];
    }
    append(child) {
      this.children.push(child);
      if (child.selected) this.value = child.value;
    }
    set innerHTML(_v) {
      throw new Error('No HTML execution');
    }
  }
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  el('preset').value = 'research';
  el('budget').value = '0';
  el('evidence').value = '[]';
  const config = {
    liveEnabled: false,
    outputLanguage: 'ru',
    allowedModes: ['subscription_only'],
    maxApiBudgetUsd: 0,
    presets: [{ name: 'research', roles: ['researcher', 'skeptic', 'verifier', 'chair'] }],
    catalogue: [],
  };
  const calls = [];
  let listener;
  const parent = {
    postMessage(message) {
      if (!message.id) return;
      let result = {};
      if (message.method === 'tools/call') {
        calls.push(message.params);
        result = {
          structuredContent: message.params.name === 'council_configuration' ? config : status,
        };
      }
      queueMicrotask(() =>
        listener({ source: parent, data: { jsonrpc: '2.0', id: message.id, result } }),
      );
    },
  };
  const context = {
    window: {
      parent,
      addEventListener(_n, fn) {
        listener = fn;
      },
    },
    document: { getElementById: el, createElement: () => new Element() },
    crypto: { randomUUID: () => 'distinct' },
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  runInNewContext(await readFile(new URL('../public/room.js', import.meta.url), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  return {
    el,
    calls,
    context,
    notify(data) {
      listener({
        source: parent,
        data: {
          jsonrpc: '2.0',
          method: 'ui/notifications/tool-result',
          params: { structuredContent: data },
        },
      });
    },
    config,
  };
}
for (const state of ['completed', 'held', 'interrupted', 'running'])
  test('reopened Room reads saved ' + state + ' receipt without dispatch', async () => {
    const result =
      state === 'completed'
        ? {
            runId: 'saved',
            state,
            outputLanguage: 'ja',
            decision: 'hold',
            synthesis: { recommendation: '確認 — العربية <script>bad()</script>' },
            receipts: [{ nativeReceipt: { turnId: 'returned-turn', outcome: 'completed' } }],
          }
        : null;
    const status = {
      run: { id: 'saved', state, result },
      events: [],
      nativeInvocations: [
        {
          receipt: {
            turnId: 'returned-turn',
            outcome: state === 'completed' ? 'completed' : 'unknown',
          },
        },
      ],
    };
    const f = await roomFixture(status);
    f.el('saved-run-id').value = 'saved';
    await f.el('read-receipt').onclick();
    assert.equal(f.calls.filter((c) => c.name === 'council_status').length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(f.calls.at(-1).arguments)), { runId: 'saved' });
    assert.equal(f.calls.filter((c) => c.name === 'council_run').length, 0);
    assert.equal(f.el('run').disabled, true);
    assert.match(f.el('receipt').textContent, /returned-turn/);
    if (result) {
      assert.equal(f.el('recommendation').textContent, result.synthesis.recommendation);
      assert.equal(f.el('recommendation').lang, 'ja');
    } else assert.match(f.el('state').textContent, /HOLD/);
    await f.el('run').onclick();
    assert.equal(f.calls.filter((c) => c.name === 'council_run').length, 0);
  });
test('host tool result restores a saved run while later config refresh preserves its lock', async () => {
  const f = await roomFixture({ run: null, events: [] });
  f.notify({
    ...f.config,
    savedStatus: {
      run: { id: 'pending', state: 'interrupted', result: null },
      events: [],
      nativeInvocations: [],
    },
  });
  assert.equal(f.el('saved-run-id').value, 'pending');
  assert.match(f.el('state').textContent, /HOLD/);
  f.notify({ ...f.config, liveEnabled: true });
  assert.equal(f.el('run').disabled, true);
  assert.equal(f.calls.filter((c) => c.name === 'council_run').length, 0);
});

test('named native runtime leaves predecessor database bytes untouched', async () => {
  const { openRuntime } = await import('../dist/runtime.js');
  const root = await mkdtemp(join(tmpdir(), 'native-storage-isolation-'));
  try {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'runs'));
    await writeFile(join(root, 'runs', 'state.sqlite'), 'immutable predecessor sentinel');
    await writeFile(join(root, 'council.local.json'), JSON.stringify(demoSettings));
    await writeFile(
      join(root, 'runtime.local.json'),
      JSON.stringify({ stateNamespace: 'distinct' }),
    );
    const runtime = openRuntime({ PLUGIN_DATA: root });
    runtime.store.begin('new', 'hash');
    runtime.close();
    assert.equal(
      await readFile(join(root, 'runs', 'state.sqlite'), 'utf8'),
      'immutable predecessor sentinel',
    );
    assert.ok((await readFile(join(root, 'runs-distinct', 'state.sqlite'))).length > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('reading a foreign saved receipt cannot unlock an uncertain active run', async () => {
  const f = await roomFixture({
    run: { id: 'foreign', state: 'completed', result: { state: 'completed' } },
    events: [],
  });
  f.notify({
    ...f.config,
    savedStatus: { run: { id: 'pending', state: 'interrupted', result: null }, events: [] },
  });
  f.el('saved-run-id').value = 'foreign';
  await f.el('read-receipt').onclick();
  assert.match(f.el('state').textContent, /unresolved active run/);
  assert.equal(f.el('run').disabled, true);
  assert.equal(f.calls.filter((c) => c.name === 'council_run').length, 0);
});

test('native admission binds the exact run, models, effort, language and evidence before dispatch', async () => {
  const { CouncilEngine } = await import('../dist/engine.js');
  const { Store } = await import('../dist/store.js');
  const { preflight } = await import('../dist/policy.js');
  const request = demoRequest('new-exact');
  request.agents = request.agents.map((a) => ({ ...a, effort: 'high' }));
  const settings = {
    ...demoSettings,
    liveEnabled: true,
    providers: [{ ...demoSettings.providers[0], kind: 'codex-local' }],
  };
  const scope = { runId: request.runId, requestSha256: preflight(settings, request).requestHash };
  const store = new Store();
  let count = 0;
  const provider = {
    complete() {
      count++;
      throw new Error('Offline transport stub');
    },
  };
  try {
    const engine = new CouncilEngine(
      settings,
      store,
      new Map([['demo', provider]]),
      undefined,
      undefined,
      scope,
    );
    for (const edit of [
      (r) => (r.runId += '-other'),
      (r) => (r.outputLanguage = 'ar'),
      (r) => (r.agents[0].effort = 'low'),
      (r) => (r.evidence[0].excerpt += ' changed'),
      (r) => (r.task += ' changed'),
    ]) {
      const changed = structuredClone(request);
      edit(changed);
      await assert.rejects(engine.run(changed), (e) => e.code === 'NATIVE_ADMISSION_SCOPE');
      assert.equal(count, 0);
      assert.equal(store.get(changed.runId), null);
    }
    const result = await engine.run(request);
    assert.equal(result.state, 'held');
    assert.equal(count, 1);
    assert.deepEqual(await engine.run(request), result);
    assert.equal(count, 1);
  } finally {
    store.close();
  }
});
