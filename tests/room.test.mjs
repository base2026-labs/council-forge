import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Execute the actual room controller against a synthetic MCP Apps parent bridge.
// No browser, model, authentication or external system is involved.
test('native room propagates pins and language, and blocks replay after an uncertain result', async () => {
  class Element {
    value = '';
    disabled = true;
    children = [];
    replaceChildren() {
      this.children = [];
    }
    append(child) {
      this.children.push(child);
      if (child.selected) this.value = child.value;
    }
  }
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  element('preset').value = 'research';
  element('mode').value = 'subscription_only';
  element('budget').value = '0';
  element('task').value = '証拠を確認';
  element('evidence').value = '[]';
  const roles = ['researcher', 'evidence_hunter', 'skeptic', 'verifier', 'chair'];
  const config = {
    liveEnabled: true,
    outputLanguage: 'en',
    allowedModes: ['subscription_only'],
    maxApiBudgetUsd: 0,
    presets: [{ name: 'research', roles }],
    catalogue: [
      {
        id: 'fixture',
        kind: 'mock',
        models: [{ id: 'fixture-model', label: 'Fixture', efforts: ['max'] }],
      },
    ],
  };
  let listener;
  const calls = [];
  const parent = {
    postMessage(message) {
      if (!message.id) return;
      let result = {};
      if (message.method === 'tools/call') {
        calls.push(message.params);
        result = {
          structuredContent:
            message.params.name === 'council_configuration'
              ? config
              : {
                  state: 'held',
                  decision: 'hold',
                  receipts: [{ diagnostic: { inferenceDispatched: true, resultKnown: false } }],
                },
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
      addEventListener(_name, fn) {
        listener = fn;
      },
    },
    document: { getElementById: element, createElement: () => new Element() },
    crypto: { randomUUID: () => 'fixture-id' },
    setTimeout: () => 1,
    clearTimeout: () => {},
    console,
  };
  const code = await readFile(new URL('../public/room.js', import.meta.url), 'utf8');
  runInNewContext(code, context);
  await new Promise((resolve) => setImmediate(resolve));
  element('language').value = 'ja';
  runInNewContext(
    "roomAgents.forEach(a => Object.assign(a,{providerId:'fixture',model:'fixture-model',effort:'max'}));",
    context,
  );
  await element('run').onclick();
  const run = calls.find((c) => c.name === 'council_run');
  assert.equal(run.arguments.request.outputLanguage, 'ja');
  assert.equal(run.arguments.request.permissionScope, 'read_only');
  assert.ok(
    run.arguments.request.agents.every(
      (a) => a.effort === 'max' && a.model === 'fixture-model' && a.instances === 1,
    ),
  );
  assert.equal(element('run').disabled, true);
  listener({
    source: parent,
    data: {
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { structuredContent: config },
    },
  });
  assert.equal(element('language').value, 'ja');
  assert.equal(element('run').disabled, true);
  await element('run').onclick();
  assert.equal(calls.filter((c) => c.name === 'council_run').length, 1);
});
