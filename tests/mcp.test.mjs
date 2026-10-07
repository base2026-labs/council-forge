import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { demoRequest } from '../dist/demo.js';
test('MCP initializes, discovers native room, denies mutations and runs offline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'council-mcp-test-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/mcp.js'],
    env: { PATH: process.env.PATH ?? '', COUNCIL_DATA_DIR: dir, COUNCIL_LIVE_ENABLED: 'false' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  try {
    await client.connect(transport);
    const list = await client.listTools();
    assert.equal(list.tools.length, 10);
    const roomTool = list.tools.find((t) => t.name === 'council_room');
    assert.equal(roomTool._meta.ui.resourceUri, 'ui://council-forge/room-v1.html');
    const room = await client.readResource({ uri: roomTool._meta.ui.resourceUri });
    assert.equal(room.contents[0].mimeType, 'text/html;profile=mcp-app');
    assert.ok(room.contents[0].text.includes('Council Room'));
    for (const name of [
      'write_repository',
      'publish_website',
      'mutate_gsc',
      'update_linear',
      'execute_shell',
    ]) {
      const denied = await client.callTool({ name, arguments: {} });
      assert.equal(denied.isError, true);
    }
    const plan = await client.callTool({
      name: 'council_plan',
      arguments: { request: { ...demoRequest('mcp-demo'), outputLanguage: 'ja' } },
    });
    assert.equal(JSON.parse(plan.content[0].text).status, 'ready');
    const run = await client.callTool({
      name: 'council_run',
      arguments: { request: { ...demoRequest('mcp-demo'), outputLanguage: 'ja' } },
    });
    const result = JSON.parse(run.content[0].text);
    assert.equal(result.simulation, true);
    assert.equal(result.decision, 'hold');
    assert.equal(result.outputLanguage, 'ja');
    assert.match(result.synthesis.recommendation, /証拠/);
    const status = await client.callTool({
      name: 'council_status',
      arguments: { runId: 'mcp-demo' },
    });
    assert.equal(JSON.parse(status.content[0].text).run.state, 'completed');
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
