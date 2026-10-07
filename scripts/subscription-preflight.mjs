// Passive metadata only: no thread/start, turn/start, tools, login or auth copying.
import { StdioRpc } from '../dist/adapters/codex-local.js';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [home] = process.argv.slice(2);
if (!home) throw new Error('Usage: subscription-preflight.mjs <existing-codex-home>');
const cwd = await mkdtemp(join(tmpdir(), 'council-metadata-'));
const rpc = new StdioRpc('codex', await realpath(home), cwd, AbortSignal.timeout(30000));
const receipt = {
  observedAt: new Date().toISOString(),
  modelTurnCreated: false,
  inferenceDispatched: false,
  methods: [],
};
async function inspect(method, params) {
  receipt.methods.push(method);
  return rpc.request(method, params);
}
try {
  await inspect('initialize', {
    clientInfo: { name: 'council_metadata', version: '0.1.0-alpha.2' },
  });
  rpc.notify('initialized', {});
  const account = await inspect('account/read', { refreshToken: false });
  receipt.account = {
    type: account.account?.type ?? null,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
  };
  const models = await inspect('model/list', { limit: 100, includeHidden: false });
  receipt.models = models.data.map(({ model, supportedReasoningEfforts }) => ({
    model,
    supportedReasoningEfforts,
  }));
  receipt.nextCursor = models.nextCursor;
} catch (error) {
  receipt.errorCode = error.code ?? 'UNKNOWN';
  receipt.message = error.message;
  process.exitCode = 1;
} finally {
  rpc.close();
  await rm(cwd, { recursive: true, force: true });
}
console.log(JSON.stringify(receipt, null, 2));
