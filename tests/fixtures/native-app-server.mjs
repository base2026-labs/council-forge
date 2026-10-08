#!/usr/bin/env node
// Offline protocol fixture. This process cannot contact any provider.
import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.CODEX_HOME;
const mode = readFileSync(join(root, 'fixture-mode'), 'utf8');
let threadId = 'native-thread',
  turnId = 'native-turn';
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n');
const event = (method, params) => send({ method, params: { threadId, turnId, ...params } });
const item = (text = 'correct', params = {}) =>
  event('item/completed', {
    item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text },
    ...params,
  });
const terminal = (status = 'completed', params = {}) =>
  event('turn/completed', { turn: { id: turnId, status, items: [] }, ...params });
const usage = () =>
  event('thread/tokenUsage/updated', {
    tokenUsage: {
      total: { inputTokens: 99999, outputTokens: 99999 },
      last: {
        inputTokens: 12,
        outputTokens: 34,
        cachedInputTokens: 5,
        reasoningOutputTokens: 8,
        totalTokens: 46,
        private: 'private-usage-fragment',
      },
    },
  });
const isolated = { features: {} };
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] !== '-c') continue;
  const [key, raw] = process.argv[++i].split('=');
  if (key.startsWith('features.')) isolated.features[key.slice(9)] = JSON.parse(raw);
  else isolated[key] = JSON.parse(raw);
}
const lines = createInterface({ input: process.stdin });
lines.on('close', () => process.exit(0));
lines.on('line', (line) => {
  const q = JSON.parse(line);
  if (q.id === undefined) return;
  const ok = (result) => send({ id: q.id, result });
  switch (q.method) {
    case 'initialize':
      ok({});
      break;
    case 'account/read':
      ok({ account: { type: 'chatgpt' }, requiresOpenaiAuth: true });
      break;
    case 'config/read':
      ok({ config: isolated });
      break;
    case 'model/list':
      ok({
        data: [
          { model: 'fixture-model', supportedReasoningEfforts: [{ reasoningEffort: 'high' }] },
          ...(mode === 'council-success'
            ? ['gpt-6.1-sol', 'gpt-6-sol'].map((model) => ({
                model,
                supportedReasoningEfforts: [{ reasoningEffort: 'max' }],
              }))
            : []),
        ],
        nextCursor: null,
      });
      break;
    case 'thread/start':
      if (mode === 'council-success') {
        appendFileSync(join(root, 'threads'), '1\n');
        const sequence = readFileSync(join(root, 'threads'), 'utf8').trim().split('\n').length;
        threadId = `fixture-thread-${sequence}`;
        turnId = `fixture-turn-${sequence}`;
      }
      ok({
        thread: { id: threadId, modelProvider: 'openai' },
        model: mode === 'council-success' ? q.params.model : 'fixture-model',
        modelProvider: 'openai',
        reasoningEffort:
          mode === 'council-success' ? q.params.config.model_reasoning_effort : 'high',
        approvalPolicy: 'never',
        sandbox: { type: 'readOnly', networkAccess: false },
        serviceTier: 'default',
        private: 'private-thread-fragment',
      });
      break;
    case 'app/installed':
      ok({ apps: [] });
      break;
    case 'mcpServerStatus/list':
      ok({ data: [], nextCursor: null });
      break;
    case 'turn/start': {
      appendFileSync(join(root, 'dispatches'), String(q.id) + '\n');
      if (mode === 'crash-pre-ack') break;
      if (mode === 'wrong-rpc-id')
        send({ id: q.id + 100, result: { turn: { id: 'foreign-turn' } } });
      const ack = () =>
        ok({
          turn: {
            id: mode === 'missing-turn-id' ? undefined : turnId,
            status: mode === 'ack-completed-only' ? 'completed' : 'inProgress',
            items: [],
          },
          private: 'private-ack-fragment',
        });
      if (mode === 'early-events' || mode === 'early-reroute') {
        if (mode === 'early-reroute') event('model/rerouted', {});
        item();
        usage();
        terminal();
        ack();
        break;
      }
      ack();
      if (mode === 'council-success') {
        const prompt = q.params.input[0].text;
        const supplied = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)).untrusted_data;
        const properties = q.params.outputSchema.properties;
        const note = prompt.includes('output language "ja"')
          ? 'オフライン証拠'
          : prompt.includes('output language "ar"')
            ? 'دليل دون اتصال'
            : prompt.includes('output language "ru"')
              ? 'Офлайн доказательство'
              : 'Offline evidence';
        const answer = properties.checks
          ? {
              checks: supplied.claims.map((c) => ({
                claimId: c.id,
                verdict: 'supported',
                evidenceIds: c.evidenceIds,
                note,
              })),
              limitations: ['Offline protocol fixture only'],
            }
          : properties.recommendation
            ? { recommendation: note, reasons: [note], nextActions: [] }
            : {
                summary: note,
                claims: [{ text: note, evidenceIds: [supplied.evidence[0].id] }],
                objections: [],
              };
        item(JSON.stringify(answer));
        usage();
        terminal();
        break;
      }
      if (mode === 'ack-completed-only') {
        lines.close();
        break;
      }
      if (mode === 'final-exit') {
        item('private-final-fragment');
        usage();
        lines.close();
        break;
      }
      if (mode === 'invalid-terminal') {
        item();
        terminal('inProgress');
        break;
      }
      if (mode === 'missing-turn-id') {
        terminal();
        break;
      }
      if (mode === 'crash-post-ack') {
        event('item/agentMessage/delta', { itemId: 'answer', delta: 'private-partial-fragment' });
        usage();
        break;
      }
      if (mode === 'partial-exit') {
        usage();
        event('item/agentMessage/delta', { itemId: 'answer', delta: 'private-partial-fragment' });
        process.stdout.write('{"method":"turn/completed","params":');
        process.exitCode = 0;
        lines.close();
        break;
      }
      if (mode === 'partial-completed') {
        event('item/agentMessage/delta', { itemId: 'answer', delta: 'private-partial-fragment' });
        terminal();
        break;
      }
      if (mode === 'interrupted') {
        usage();
        item('private-unfinished-fragment');
        terminal('interrupted', {
          turn: {
            id: 'native-turn',
            status: 'interrupted',
            error: { codexErrorInfo: 'usageLimitExceeded', message: 'private-error-fragment' },
          },
        });
        break;
      }
      if (mode === 'terminal-first') {
        terminal();
        item('late-output');
        break;
      }
      if (mode === 'failed-first') {
        terminal('failed');
        item('late-output');
        terminal();
        break;
      }
      if (mode === 'wrong-thread' || mode === 'wrong-turn' || mode === 'missing-event-id') {
        const ids =
          mode === 'wrong-thread'
            ? { threadId: 'other-thread' }
            : { turnId: mode === 'wrong-turn' ? 'other-turn' : undefined };
        item('foreign-output', ids);
        event('model/rerouted', { ...ids });
        event('item/started', { ...ids, item: { type: 'fileChange' } });
        event('thread/tokenUsage/updated', { ...ids, tokenUsage: { last: { inputTokens: 888 } } });
        if (mode === 'wrong-thread') terminal('failed', { threadId: 'other-thread' });
        else
          terminal('failed', {
            turn: { id: mode === 'wrong-turn' ? 'other-turn' : undefined, status: 'failed' },
          });
      }
      item();
      usage();
      usage();
      terminal();
      if (mode === 'duplicate-terminal') {
        terminal();
        terminal('failed');
        item('late-output');
      }
      break;
    }
    default:
      send({ id: q.id, error: { code: -32601, message: 'private-rpc-fragment' } });
  }
});
