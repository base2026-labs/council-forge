import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { scope, inspection, source, rendered, analytics, copy } from './fixtures/seo-exports.mjs';
const guard = fileURLToPath(new URL('./fixtures/no-dispatch.mjs', import.meta.url));
const current = (fixture) => {
  const p = copy(fixture);
  p.observedAt = new Date(Date.now() - 3000).toISOString();
  if (p.sourceType === 'gsc_url_inspection_export')
    p.response.inspectionResult.indexStatusResult.lastCrawlTime = '2020-01-01T00:00:00Z';
  return p;
};
test('CLI imports typed/generic packets with all network, DNS and provider subprocess dispatch denied', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'council-export-cli-'));
  try {
    const path = join(dir, 'packet.json');
    await writeFile(
      path,
      JSON.stringify({ scope, exports: [inspection, source, rendered, analytics].map(current) }),
    );
    const run = spawnSync(
      process.execPath,
      ['--import', guard, 'dist/cli.js', 'import-evidence', path],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.inferenceDispatched, false);
    assert.equal(result.networkAccess, false);
    assert.equal(result.evidence.length, 4);
    const genericScope = {
      collector: scope.collector,
      permission: 'read',
      resources: scope.resources,
      maxObservations: 10,
      maxBytes: 200000,
    };
    await writeFile(path, JSON.stringify({ scope: genericScope, observations: result.evidence }));
    const generic = spawnSync(
      process.execPath,
      ['--import', guard, 'dist/cli.js', 'import-evidence', path],
      { encoding: 'utf8' },
    );
    assert.equal(generic.status, 0, generic.stderr);
    assert.deepEqual(JSON.parse(generic.stdout).evidence, result.evidence);
    await writeFile(path, Buffer.alloc(200001, 32));
    const large = spawnSync(
      process.execPath,
      ['--import', guard, 'dist/cli.js', 'import-evidence', path],
      { encoding: 'utf8' },
    );
    assert.equal(large.status, 1);
    assert.equal(
      JSON.parse(large.stderr.split('\n').find((x) => x.startsWith('{'))).error,
      'COLLECTION_LIMIT',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('existing MCP import handles typed exports without inference, network or extra capabilities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'council-export-mcp-'));
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
  const client = new Client({ name: 'typed-test', version: '1.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 10);
    const tool = tools.tools.find((t) => t.name === 'council_import_observations');
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
    const result = await client.callTool({
      name: tool.name,
      arguments: { scope, exports: [current(inspection), current(source)] },
    });
    assert.ok(!result.isError, JSON.stringify(result));
    const normalized = result.structuredContent;
    assert.equal(normalized.networkAccess, false);
    assert.equal(normalized.inferenceDispatched, false);
    assert.equal(normalized.evidence[0].observation.basis, 'provider_reported');
    assert.equal(normalized.evidence[1].observation.basis, 'observed_supplied_document');
    const config = (await client.callTool({ name: 'council_configuration', arguments: {} }))
      .structuredContent;
    assert.deepEqual(config.capabilities.modelTools, []);
    assert.equal(config.liveEnabled, false);
    const status = await client.callTool({
      name: 'council_status',
      arguments: { runId: 'no-dispatch' },
    });
    assert.deepEqual(status.structuredContent.events, []);
    assert.equal(status.structuredContent.run, null);
    const bad = await client.callTool({
      name: tool.name,
      arguments: { scope: { ...scope, resources: [] }, exports: [current(source)] },
    });
    assert.equal(bad.isError, true);
    const missing = await client.callTool({ name: tool.name, arguments: { scope } });
    assert.equal(missing.isError, true);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
});
