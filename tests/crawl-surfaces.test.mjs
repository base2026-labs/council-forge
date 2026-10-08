import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const guard = fileURLToPath(new URL('./fixtures/no-dispatch.mjs', import.meta.url));
function packet() {
  const result = spawnSync(process.execPath, ['tests/fixtures/crawl-packet.mjs'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test('CLI crawl mode HOLD example cannot fetch and legacy collect-public remains a separate command', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'council-crawl-cli-'));
  try {
    const source = `import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';os.homedir=()=>${JSON.stringify(dir)};syncBuiltinESMExports();process.argv=['node','cli','crawl-public','examples/crawl-hold.scope.json'];await import('./dist/cli.js');`;
    const held = spawnSync(
      process.execPath,
      ['--import', guard, '--input-type=module', '-e', source],
      { encoding: 'utf8' },
    );
    assert.equal(held.status, 0, held.stderr);
    const result = JSON.parse(held.stdout);
    assert.equal(result.requests, 0);
    assert.equal(result.completion.status, 'HOLD');
    assert.deepEqual(result.completion.reasons, ['ROBOTS_SCOPE_MISSING']);
    assert.equal(result.inferenceDispatched, false);
    const help = spawnSync(process.execPath, ['--import', guard, 'dist/cli.js'], {
      encoding: 'utf8',
    });
    assert.equal(help.status, 0, help.stderr);
    const usage = JSON.parse(help.stdout).usage;
    assert.ok(usage.some((x) => x.startsWith('collect-public ')));
    assert.ok(usage.some((x) => x.startsWith('crawl-public ')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('CLI reimports bounded crawl receipts with all external network and provider dispatch denied', async () => {
  const input = packet(),
    dir = await mkdtemp(join(tmpdir(), 'council-crawl-import-'));
  try {
    const path = join(dir, 'packet.json');
    await writeFile(path, JSON.stringify(input));
    const result = spawnSync(
      process.execPath,
      ['--import', guard, 'dist/cli.js', 'import-evidence', path],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const imported = JSON.parse(result.stdout);
    assert.deepEqual(imported.evidence, input.observations);
    assert.equal(imported.networkAccess, false);
    assert.equal(imported.inferenceDispatched, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('existing MCP import accepts crawl metadata without registering acquisition tools or changing capability/model/budget pins', async () => {
  const input = packet(),
    dir = await mkdtemp(join(tmpdir(), 'council-crawl-mcp-'));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', guard, 'dist/mcp.js'],
    env: {
      PATH: process.env.PATH ?? '',
      COUNCIL_DATA_DIR: dir,
      COUNCIL_GLOBAL_DB: join(dir, 'global.sqlite'),
      COUNCIL_LIVE_ENABLED: 'false',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'crawl-test', version: '1.0' });
  try {
    await client.connect(transport);
    const before = (await client.callTool({ name: 'council_configuration', arguments: {} }))
      .structuredContent;
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 10);
    assert.equal(
      tools.tools.some((t) => /crawl|collect_public/.test(t.name)),
      false,
    );
    const imported = await client.callTool({
      name: 'council_import_observations',
      arguments: input,
    });
    assert.equal(imported.isError, undefined, JSON.stringify(imported));
    assert.deepEqual(imported.structuredContent.evidence, input.observations);
    assert.equal(imported.structuredContent.networkAccess, false);
    const after = (await client.callTool({ name: 'council_configuration', arguments: {} }))
      .structuredContent;
    assert.deepEqual(after, before);
    assert.deepEqual(after.capabilities.modelTools, []);
    assert.equal(after.liveEnabled, false);
    const tool = tools.tools.find((t) => t.name === 'council_import_observations');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
