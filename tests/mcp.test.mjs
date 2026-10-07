import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { demoRequest } from '../dist/demo.js';
test('MCP initializes, lists six tools, plans and runs offline', async () => {
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
    assert.equal(list.tools.length, 6);
    const plan = await client.callTool({
      name: 'council_plan',
      arguments: { request: demoRequest('mcp-demo') },
    });
    assert.equal(JSON.parse(plan.content[0].text).status, 'ready');
    const run = await client.callTool({
      name: 'council_run',
      arguments: { request: demoRequest('mcp-demo') },
    });
    const result = JSON.parse(run.content[0].text);
    assert.equal(result.simulation, true);
    assert.equal(result.decision, 'hold');
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
