// Official installed-plugin acceptance; model work requires an explicit request file
// and trusted operator live settings. Never creates credentials or grants auth.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const [home, marketplace, requestPath] = process.argv.slice(2);
if (!home || !marketplace)
  throw new Error('Usage: plugin-smoke.mjs <installed-codex-home> <marketplace-path>');
const child = spawn('codex', ['app-server', '--stdio'], {
  env: {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    CODEX_HOME: home,
    ...(process.env.COUNCIL_CONFIG ? { COUNCIL_CONFIG: process.env.COUNCIL_CONFIG } : {}),
    ...(process.env.COUNCIL_DATA_DIR ? { COUNCIL_DATA_DIR: process.env.COUNCIL_DATA_DIR } : {}),
    COUNCIL_LIVE_ENABLED: process.env.COUNCIL_LIVE_ENABLED ?? 'false',
  },
  cwd: marketplace,
  stdio: 'pipe',
});
const pending = new Map();
let seq = 0;
child.stderr.resume();
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method && message.id !== undefined) {
    child.stdin.write(
      JSON.stringify({
        id: message.id,
        error: {
          code: -32601,
          message: 'No auth, permission or tool approvals in metadata smoke.',
        },
      }) + '\n',
    );
    return;
  }
  const request = pending.get(message.id);
  if (request) {
    clearTimeout(request.timer);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  }
});
child.on('exit', () => {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(new Error('Host exited.'));
  }
  pending.clear();
});
function call(method, params, timeout = 30000) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('Metadata timeout: ' + method));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
}
const receipt = {
  observedAt: new Date().toISOString(),
  inferenceDispatched: false,
  modelTurnCreated: false,
  host: 'codex-cli 0.160.0',
  methods: [],
};
async function inspect(method, params, timeout) {
  receipt.methods.push(method);
  return call(method, params, timeout);
}
try {
  receipt.initialize = await inspect('initialize', {
    clientInfo: { name: 'council_forge_plugin_acceptance', version: '0.1.0-alpha.2' },
    capabilities: { experimentalApi: true },
  });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
  const account = await inspect('account/read', { refreshToken: false });
  receipt.account = {
    type: account.account?.type ?? null,
    requiresOpenaiAuth: account.requiresOpenaiAuth,
  };
  receipt.plugin = await inspect('plugin/read', {
    marketplacePath: marketplace + '/.agents/plugins/marketplace.json',
    pluginName: 'council-forge',
  });
  receipt.mcp = await inspect('mcpServerStatus/list', { limit: 100 });
  receipt.installed = await inspect('plugin/installed', {});
  const expectedVersion = JSON.parse(readFileSync(marketplace + '/package.json', 'utf8')).version;
  const server = receipt.mcp.data.find((item) => item.name === 'council-forge');
  if (server?.serverInfo?.version !== expectedVersion)
    throw new Error('Installed MCP version does not match the candidate: ' + expectedVersion);
  receipt.expectedVersion = expectedVersion;
  receipt.installedServerVersion = server.serverInfo.version;
  const thread = await inspect('thread/start', {
    model: 'gpt-6.1-sol',
    cwd: marketplace,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    ephemeral: true,
    serviceTier: 'default',
    config: { model_reasoning_effort: 'max' },
  });
  receipt.thread = {
    id: thread.thread.id,
    model: thread.model,
    reasoningEffort: thread.reasoningEffort,
    approvalPolicy: thread.approvalPolicy,
    sandbox: thread.sandbox,
  };
  receipt.room = await inspect('mcpServer/tool/call', {
    threadId: thread.thread.id,
    server: 'council-forge',
    tool: 'council_room',
    arguments: {},
  });
  receipt.mutationDenials = [];
  for (const tool of [
    'write_repository',
    'publish_website',
    'mutate_gsc',
    'update_linear',
    'execute_shell',
  ]) {
    try {
      const response = await inspect('mcpServer/tool/call', {
        threadId: thread.thread.id,
        server: 'council-forge',
        tool,
        arguments: {},
      });
      receipt.mutationDenials.push({ tool, response, denied: response.isError === true });
    } catch (error) {
      receipt.mutationDenials.push({ tool, denied: true, error: error.message });
    }
  }
  if (requestPath) {
    const request = JSON.parse(readFileSync(requestPath, 'utf8'));
    receipt.input = request;
    receipt.plan = await inspect('mcpServer/tool/call', {
      threadId: thread.thread.id,
      server: 'council-forge',
      tool: 'council_plan',
      arguments: { request },
    });
    if (receipt.plan.isError)
      throw new Error('Council admission failed before inference; no run submitted.');
    receipt.inferenceAttemptRequested = true;
    receipt.run = await inspect(
      'mcpServer/tool/call',
      {
        threadId: thread.thread.id,
        server: 'council-forge',
        tool: 'council_run',
        arguments: { request },
      },
      request.timeoutMs + 30000,
    );
    receipt.status = await inspect('mcpServer/tool/call', {
      threadId: thread.thread.id,
      server: 'council-forge',
      tool: 'council_status',
      arguments: { runId: request.runId },
    });
    const output = JSON.parse(receipt.run.content[0].text);
    receipt.inferenceDispatched =
      output.receipts?.some(
        (r) =>
          r.diagnostic?.inferenceDispatched === true ||
          (r.requestId && r.billing === 'subscription'),
      ) ?? false;
    receipt.providerReceipts = output.receipts;
    receipt.liveCouncilAccepted = output.simulation === false && output.state === 'completed';
    receipt.modelTurnCreated =
      output.receipts?.some(
        (r) => r.diagnostic?.turnAccepted === true || (r.requestId && r.billing === 'subscription'),
      ) ?? false;
    receipt.inferenceOutcomeKnown = output.state === 'completed';
  }
  if (receipt.plugin?.plugin?.root) {
    const manifest = readFileSync(receipt.plugin.plugin.root + '/plugin.json');
    receipt.manifestSha256 = createHash('sha256').update(manifest).digest('hex');
  }
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
  lines.close();
}
console.log(JSON.stringify(receipt, null, 2));
