import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Store } from '../dist/store.js';
import { CouncilEngine } from '../dist/engine.js';
import { demoSettings, demoRequest } from '../dist/demo.js';

// Five actual adapter invocations against executable offline protocol fixtures.
// No codex executable, account, network, credentials or provider is used.
for (const language of ['en', 'ru', 'ja', 'ar'])
  test(
    'complete native protocol council persists across lost delivery: ' + language,
    { skip: process.platform === 'win32' },
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'offline-native-council-'));
      try {
        const executable = join(root, 'server.mjs');
        await writeFile(
          executable,
          await readFile(new URL('./fixtures/native-app-server.mjs', import.meta.url)),
          { mode: 0o700 },
        );
        await writeFile(join(root, 'fixture-mode'), 'council-success');
        const config = {
          id: 'native-fixture',
          kind: 'codex-local',
          codexHome: root,
          codexExecutable: executable,
          models: ['gpt-6.1-sol', 'gpt-6-sol'].map((id) => ({
            id,
            label: 'Offline protocol fixture',
            efforts: ['max'],
            responseIds: [id],
          })),
        };
        const settings = {
          ...demoSettings,
          providers: [config],
          liveEnabled: true,
          maxConcurrency: 1,
          maxCallsPerRun: 5,
        };
        const request = demoRequest('new-' + language);
        request.outputLanguage = language;
        request.agents = [
          ...request.agents.slice(0, 1),
          { ...request.agents[0], id: 'hunter', role: 'evidence_hunter' },
          ...request.agents.slice(1),
        ].map((a, i) => ({
          ...a,
          providerId: config.id,
          model: i === 1 || a.role === 'verifier' ? 'gpt-6-sol' : 'gpt-6.1-sol',
          effort: 'max',
        }));
        const state = join(root, 'state.sqlite');
        // Finish is durable before returning. Kill the consumer before it can deliver
        // the result to a host; no final JSON is sent to the test process.
        const moduleUrl = new URL('../dist/', import.meta.url).href;
        const source = `import {Store} from ${JSON.stringify(moduleUrl + 'store.js')};import {CouncilEngine} from ${JSON.stringify(moduleUrl + 'engine.js')};import {CodexLocalProvider} from ${JSON.stringify(moduleUrl + 'adapters/codex-local.js')};const store=new Store(${JSON.stringify(state)});await new CouncilEngine(${JSON.stringify(settings)},store,new Map([['native-fixture',new CodexLocalProvider(${JSON.stringify(config)})]])).run(${JSON.stringify(request)});process.kill(process.pid,'SIGKILL');`;
        const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let error = '';
        child.stderr.on('data', (b) => (error += b));
        const [code, signal] = await once(child, 'exit');
        assert.equal(signal, 'SIGKILL', error);
        assert.equal(code, null);
        const store = new Store(state);
        try {
          const before = store.get(request.runId);
          assert.equal(before.state, 'completed');
          const result = before.result;
          assert.equal(result.proposals.length, 2);
          assert.equal(result.receipts.length, 5);
          assert.equal(result.verification.checks.length, 2);
          assert.ok(result.critique);
          assert.ok(result.synthesis.recommendation);
          assert.equal(result.outputLanguage, language);
          assert.equal(result.apiExposureUsd, 0);
          assert.deepEqual(result.modelSelections, request.agents);
          const native = store.nativeInvocations(request.runId);
          assert.equal(native.length, 5);
          assert.equal(new Set(native.map((n) => n.receipt.turnId)).size, 5);
          assert.ok(
            native.every(
              (n) =>
                n.receipt.state === 'terminal' &&
                n.receipt.outcome === 'completed' &&
                n.receipt.usage.inputTokens === 12 &&
                n.receipt.usage.costUsd === null,
            ),
          );
          assert.ok(result.receipts.every((r) => r.requestId === null && r.actualEffort === 'max'));
          store.recover();
          assert.deepEqual(store.get(request.runId), before);
          assert.deepEqual(store.nativeInvocations(request.runId), native);
          const noDispatch = {
            complete() {
              throw new Error('Restart must not dispatch');
            },
          };
          assert.deepEqual(
            await new CouncilEngine(settings, store, new Map([['native-fixture', noDispatch]])).run(
              request,
            ),
            result,
          );
          assert.equal(
            (await readFile(join(root, 'dispatches'), 'utf8')).trim().split('\n').length,
            5,
          );
        } finally {
          store.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
