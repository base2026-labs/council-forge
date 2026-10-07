import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const [installedRoot, dataDirectory, requestPath] = process.argv.slice(2);
if (!installedRoot || !dataDirectory)
  throw new Error('Usage: mcp-acceptance.mjs <installed-root> <state-dir> [request-path]');
const client = new Client({ name: 'council_forge_install_acceptance', version: '0.1.0-alpha.2' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(installedRoot, 'dist/mcp.js')],
  cwd: installedRoot,
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    COUNCIL_DATA_DIR: dataDirectory,
    COUNCIL_LIVE_ENABLED: process.env.COUNCIL_LIVE_ENABLED ?? 'false',
    ...(process.env.COUNCIL_CONFIG ? { COUNCIL_CONFIG: process.env.COUNCIL_CONFIG } : {}),
  },
  stderr: 'pipe',
});
const receipt = {
  observedAt: new Date().toISOString(),
  installedRoot,
  simulation: true,
  liveCouncilAccepted: false,
};
try {
  await client.connect(transport);
  receipt.tools = await client.listTools();
  receipt.resources = await client.listResources();
  receipt.room = await client.callTool({ name: 'council_room', arguments: {} });
  const uri = receipt.tools.tools.find((t) => t.name === 'council_room')._meta.ui.resourceUri;
  const resource = await client.readResource({ uri });
  receipt.uiResource = {
    uri,
    mimeType: resource.contents[0].mimeType,
    bytes: Buffer.byteLength(resource.contents[0].text),
    sha256: createHash('sha256').update(resource.contents[0].text).digest('hex'),
  };
  receipt.mutationDenials = [];
  for (const name of [
    'write_repository',
    'publish_website',
    'mutate_gsc',
    'update_linear',
    'execute_shell',
  ]) {
    const result = await client.callTool({ name, arguments: {} });
    receipt.mutationDenials.push({ name, result });
    if (!result.isError) throw new Error('Mutation capability unexpectedly exposed.');
  }
  if (requestPath) {
    const request = JSON.parse(readFileSync(requestPath, 'utf8'));
    receipt.input = request;
    receipt.plan = await client.callTool({ name: 'council_plan', arguments: { request } });
    receipt.run = await client.callTool({ name: 'council_run', arguments: { request } });
    receipt.status = await client.callTool({
      name: 'council_status',
      arguments: { runId: request.runId },
    });
    const out = JSON.parse(receipt.run.content[0].text);
    receipt.simulation = out.simulation;
    receipt.liveCouncilAccepted = !out.simulation && out.state === 'completed';
  }
} catch (error) {
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  await client.close();
}
console.log(JSON.stringify(receipt, null, 2));
