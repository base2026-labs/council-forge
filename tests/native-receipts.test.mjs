import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../dist/store.js';
import { CouncilEngine } from '../dist/engine.js';
import { CodexLocalProvider } from '../dist/adapters/codex-local.js';
import { demoSettings, demoRequest } from '../dist/demo.js';
const unix = { skip: process.platform === 'win32' };
const fixtureSource = await readFile(
  new URL('./fixtures/native-app-server.mjs', import.meta.url),
  'utf8',
);
async function fixture(mode, fn) {
  const root = await mkdtemp(join(tmpdir(), 'council-native-receipts-'));
  const executable = join(root, 'fixture.mjs');
  await writeFile(executable, fixtureSource, { mode: 0o700 });
  await writeFile(join(root, 'fixture-mode'), mode);
  const config = {
    ...demoSettings.providers[0],
    kind: 'codex-local',
    codexHome: root,
    codexExecutable: executable,
  };
  const settings = { ...demoSettings, providers: [config], liveEnabled: true, maxConcurrency: 1 };
  const request = demoRequest('native-receipt-fixture');
  request.mode = 'subscription_only';
  request.agents = request.agents.map((a) => ({ ...a, effort: 'high' }));
  const invocation = {
    agent: request.agents[0],
    phase: 'propose',
    prompt: 'private-prompt-fragment',
    maxOutputTokens: 256,
    evidence: [],
    claims: [],
    signal: AbortSignal.timeout(5000),
  };
  try {
    await fn({ root, config, settings, request, invocation });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
function assertPrivate(receipts) {
  assert.ok(!JSON.stringify(receipts).includes('private-'));
  assert.ok(!JSON.stringify(receipts).includes('foreign-output'));
}
test('native identities and acknowledgement are persisted before complete returns', unix, () =>
  fixture('success', async ({ root, config, invocation }) => {
    const path = join(root, 'state.sqlite');
    const store = new Store(path);
    const snapshots = [];
    try {
      const result = await new CodexLocalProvider(config).complete({
        ...invocation,
        onNativeReceipt(receipt) {
          store.nativeReceipt(
            'call',
            'run',
            { prompt: 'private-context-fragment' },
            { ...receipt, output: 'private-receipt-fragment' },
          );
          const reader = new Store(path);
          try {
            snapshots.push(reader.nativeInvocations('run')[0].receipt);
          } finally {
            reader.close();
          }
        },
      });
      const ack = snapshots.find((x) => x.boundary === 'turn_acknowledged');
      assert.equal(ack.threadId, 'native-thread');
      assert.equal(ack.turnId, 'native-turn');
      assert.equal(ack.turnStartRequestId, 9);
      assert.equal(ack.state, 'acknowledged');
      assert.equal(ack.outcome, 'unknown');
      assert.equal(result.requestId, null);
      assert.equal(result.nativeReceipt.turnId, 'native-turn');
      assert.equal(result.nativeReceipt.outcome, 'completed');
      assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 34, costUsd: null });
      assert.equal(snapshots.filter((x) => x.state === 'terminal').length, 1);
      assertPrivate(snapshots);
      assertPrivate(store.events('run'));
      assertPrivate(store.nativeInvocations('run'));
    } finally {
      store.close();
    }
  }),
);
for (const mode of [
  'wrong-thread',
  'wrong-turn',
  'missing-event-id',
  'early-events',
  'duplicate-terminal',
  'wrong-rpc-id',
])
  test('exact native correlation: ' + mode, unix, () =>
    fixture(mode, async ({ config, invocation }) => {
      const receipts = [];
      const result = await new CodexLocalProvider(config).complete({
        ...invocation,
        onNativeReceipt: (r) => receipts.push(r),
      });
      assert.equal(result.text, 'correct');
      assert.equal(result.nativeReceipt.turnId, 'native-turn');
      assert.equal(result.nativeReceipt.outcome, 'completed');
      assert.equal(result.usage.inputTokens, 12);
      assert.equal(receipts.filter((r) => r.state === 'terminal').length, 1);
      assertPrivate(receipts);
    }),
  );
for (const [mode, code, outcome] of [
  ['missing-turn-id', 'CODEX_ACK_INVALID', 'unknown'],
  ['early-reroute', 'MODEL_REROUTED', 'unknown'],
  ['ack-completed-only', 'CODEX_CLOSED', 'unknown'],
  ['final-exit', 'CODEX_CLOSED', 'unknown'],
  ['invalid-terminal', 'CODEX_TERMINAL_INVALID', 'unknown'],
  ['partial-exit', 'CODEX_CLOSED', 'unknown'],
  ['partial-completed', 'EMPTY_COMPLETION', 'completed'],
  ['terminal-first', 'EMPTY_COMPLETION', 'completed'],
  ['failed-first', 'CODEX_INCOMPLETE', 'failed'],
  ['interrupted', 'CODEX_INCOMPLETE', 'interrupted'],
])
  test('native incomplete outcome is bounded and sanitized: ' + mode, unix, () =>
    fixture(mode, async ({ config, invocation }) => {
      const receipts = [];
      await assert.rejects(
        () =>
          new CodexLocalProvider(config).complete({
            ...invocation,
            onNativeReceipt: (r) => receipts.push(r),
          }),
        (error) => {
          assert.equal(error.code, code);
          assert.equal(error.receipt.nativeReceipt.outcome, outcome);
          if (mode === 'interrupted' || mode === 'partial-exit' || mode === 'final-exit') {
            assert.equal(error.receipt.usage.inputTokens, 12);
            assert.equal(error.receipt.usage.outputTokens, 34);
          }
          return true;
        },
      );
      assert.ok(receipts.length > 2);
      assertPrivate(receipts);
    }),
  );
test('engine held receipt retains native identities and reported usage', unix, () =>
  fixture('interrupted', async ({ config, settings, request }) => {
    const store = new Store();
    try {
      const engine = new CouncilEngine(
        settings,
        store,
        new Map([['demo', new CodexLocalProvider(config)]]),
      );
      const result = await engine.run(request);
      assert.equal(result.decision, 'hold');
      assert.equal(result.receipts[0].nativeReceipt.turnId, 'native-turn');
      assert.equal(result.receipts[0].usage.inputTokens, 12);
      assert.equal(store.nativeInvocations(request.runId)[0].receipt.outcome, 'interrupted');
      const events = store.events(request.runId);
      const ack = events.findIndex(
        (e) => e.type === 'native_receipt' && JSON.parse(e.data).boundary === 'turn_acknowledged',
      );
      const received = events.findIndex((e) => e.type === 'call_received');
      assert.ok(ack > -1 && received > ack);
      assertPrivate(events);
    } finally {
      store.close();
    }
  }),
);
for (const [mode, boundary] of [
  ['success', 'turn_requested'],
  ['crash-pre-ack', 'turn_dispatched'],
  ['crash-post-ack', 'turn_acknowledged'],
  ['success', 'turn_completed'],
])
  test('crash/restart retains evidence and never replays: ' + mode + '/' + boundary, unix, () =>
    fixture(mode, async ({ root, config, settings, request }) => {
      const database = join(root, 'state.sqlite');
      const script = join(root, 'engine.mjs');
      const base = new URL('../dist/', import.meta.url).href;
      await writeFile(
        script,
        [
          "import { readFileSync } from 'node:fs';",
          "import { Store } from '" + base + "store.js';",
          "import { CouncilEngine } from '" + base + "engine.js';",
          "import { CodexLocalProvider } from '" + base + "adapters/codex-local.js';",
          'const context = JSON.parse(readFileSync(process.argv[2], "utf8"));',
          'const store = new Store(context.database);',
          'const original = store.nativeReceipt.bind(store);',
          'store.nativeReceipt = (...args) => { const value = original(...args); if (args[3].boundary === context.boundary) { process.send({ ready: true }); process.kill(process.pid, "SIGSTOP"); } return value; };',
          'const engine = new CouncilEngine(context.settings, store, new Map([["demo", new CodexLocalProvider(context.config)]]));',
          'await engine.run(context.request);',
        ].join('\n'),
      );
      const contextPath = join(root, 'context.json');
      await writeFile(
        contextPath,
        JSON.stringify({ database, config, settings, request, boundary }),
      );
      const child = spawn(process.execPath, [script, contextPath], {
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
      let diagnostics = '';
      child.stderr.on('data', (x) => {
        diagnostics += x;
      });
      const exit = once(child, 'exit');
      try {
        const [message] = await Promise.race([
          once(child, 'message'),
          exit.then(() => {
            throw new Error('fixture exited before boundary: ' + diagnostics);
          }),
          delay(5000).then(() => {
            throw new Error('fixture boundary timeout: ' + diagnostics);
          }),
        ]);
        assert.equal(message.ready, true);
        let dispatches;
        for (let i = 0; boundary !== 'turn_requested' && i < 100; i++) {
          try {
            dispatches = await readFile(join(root, 'dispatches'), 'utf8');
            break;
          } catch {
            await delay(10);
          }
        }
        if (boundary === 'turn_requested') assert.equal(dispatches, undefined);
        else assert.equal(dispatches.trim(), '9');
        const reader = new Store(database);
        try {
          const before = reader.nativeInvocations(request.runId)[0].receipt;
          assert.equal(before.threadId, 'native-thread');
          assert.equal(
            before.turnId,
            ['turn_requested', 'turn_dispatched'].includes(boundary) ? null : 'native-turn',
          );
          assert.equal(before.outcome, boundary === 'turn_completed' ? 'completed' : 'unknown');
          if (boundary === 'turn_acknowledged') assert.equal(before.state, 'acknowledged');
        } finally {
          reader.close();
        }
        child.kill('SIGKILL');
        await exit;
        const store = new Store(database);
        try {
          store.recover();
          store.recover();
          let replays = 0;
          const provider = {
            complete() {
              replays++;
              throw new Error('must not dispatch');
            },
          };
          const engine = new CouncilEngine(settings, store, new Map([['demo', provider]]));
          const result = await engine.run(request);
          assert.equal(result.state, 'interrupted');
          assert.equal(result.replayed, false);
          assert.equal(replays, 0);
          const receipt = store.nativeInvocations(request.runId)[0].receipt;
          assert.equal(receipt.state, boundary === 'turn_completed' ? 'terminal' : 'unknown');
          assert.equal(receipt.outcome, boundary === 'turn_completed' ? 'completed' : 'unknown');
          assert.equal(receipt.turnStartRequestId, 9);
          assert.equal(
            receipt.turnId,
            ['turn_requested', 'turn_dispatched'].includes(boundary) ? null : 'native-turn',
          );
          assert.equal(
            store
              .events(request.runId)
              .filter(
                (e) => e.type === 'native_receipt' && JSON.parse(e.data).boundary === 'recovery',
              ).length,
            boundary === 'turn_completed' ? 0 : 1,
          );
          if (boundary === 'turn_requested')
            await assert.rejects(() => readFile(join(root, 'dispatches')), { code: 'ENOENT' });
          else assert.equal((await readFile(join(root, 'dispatches'), 'utf8')).trim(), '9');
        } finally {
          store.close();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exit;
        }
      }
    }),
  );

test('failure to persist dispatch intent prevents a native transport write', unix, () =>
  fixture('success', async ({ root, config, invocation }) => {
    await assert.rejects(
      () =>
        new CodexLocalProvider(config).complete({
          ...invocation,
          onNativeReceipt(receipt) {
            if (receipt.boundary === 'turn_requested') throw new Error('fixture-store-failure');
          },
        }),
      (error) => {
        assert.equal(error.receipt.nativeReceipt.outcome, 'not_dispatched');
        assert.equal(error.receipt.nativeReceipt.inferenceDispatched, false);
        return true;
      },
    );
    await assert.rejects(() => readFile(join(root, 'dispatches')), { code: 'ENOENT' });
  }),
);
test('additive receipt storage never invents identities for legacy UNKNOWN records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'council-native-legacy-'));
  const path = join(root, 'state.sqlite');
  const old = new DatabaseSync(path);
  old.exec(
    'CREATE TABLE runs (id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, result TEXT); CREATE TABLE calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, reserved INTEGER NOT NULL, charged INTEGER, state TEXT NOT NULL); CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL);',
  );
  const result = JSON.stringify({ state: 'held', outcome: 'UNKNOWN', usage: null });
  old.prepare('INSERT INTO runs VALUES (?,?,?,?)').run('legacy', 'hash', 'held', result);
  old
    .prepare('INSERT INTO calls VALUES (?,?,?,NULL,?)')
    .run('legacy/api', 'legacy', 1000, 'unknown');
  old
    .prepare('INSERT INTO events(run_id,at,type,data) VALUES (?,?,?,?)')
    .run('legacy', '2026-10-07T20:28:47Z', 'agent_started', '{"model":"fixture-model"}');
  old.close();
  const store = new Store(path);
  try {
    const before = store.events('legacy');
    store.recover();
    assert.deepEqual(store.nativeInvocations('legacy'), []);
    assert.deepEqual(store.events('legacy'), before);
    assert.deepEqual(store.get('legacy').result, JSON.parse(result));
    assert.equal(store.exposure('legacy'), 1000);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
