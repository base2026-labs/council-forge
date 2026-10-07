import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RequestSchema, Identifier, AgentSchema, EvidenceSchema } from './schema.ts';
import { preflight, CouncilError } from './policy.ts';
import { openRuntime, catalogue } from './runtime.ts';
import { inspectHtml } from './seo.ts';
import { ROOM_URI, roomHtml } from './room.ts';
import { createPreset, presetContracts, PresetName } from './presets.ts';
import { contracts } from './roles.ts';
import { councilCapabilities } from './capabilities.ts';
import { ObservationScope, importObservations, collectorContracts } from './collectors.ts';
const runtime = openRuntime();
const server = new McpServer({ name: 'council-forge', version: '0.1.0-alpha.2' });
const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  structuredContent:
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { data: value },
});
const safe = async (fn: () => unknown | Promise<unknown>) => {
  try {
    return text(await fn());
  } catch (e) {
    return {
      ...text({
        error: e instanceof CouncilError ? e.code : 'VALIDATION_OR_RUNTIME_ERROR',
        message: 'No automatic fallback or retry was attempted.',
      }),
      isError: true,
    };
  }
};
const configuration = () => ({
  catalogue: catalogue(runtime.settings),
  presets: presetContracts(),
  roles: contracts(),
  allowedModes: runtime.settings.allowedModes,
  liveEnabled: runtime.settings.liveEnabled,
  maxApiBudgetUsd: runtime.settings.maxRunApiUsd,
  outputLanguage: runtime.settings.outputLanguage,
  capabilities: councilCapabilities(),
  collectors: collectorContracts(),
});
server.registerTool(
  'council_models',
  {
    description:
      'List operator-configured models and effort values. This is not a live entitlement check. Never accepts or returns credentials.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => text(catalogue(runtime.settings)),
);
server.registerTool(
  'council_plan',
  {
    description:
      'Validate council roles, billing mode, instances and limits without inference or network access.',
    inputSchema: { request: RequestSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ request }) =>
    safe(() => {
      const p = preflight(runtime.settings, request);
      return {
        status: p.status,
        simulation: p.simulation,
        agents: p.agents,
        plannedCalls: p.plannedCalls,
        maxConcurrency: p.maxConcurrency,
        requestHash: p.requestHash,
        warnings: p.warnings,
        outputLanguage: p.request.outputLanguage,
        permissionScope: p.request.permissionScope,
      };
    }),
);
server.registerResource(
  'council-room',
  ROOM_URI,
  { mimeType: 'text/html;profile=mcp-app' },
  async () => ({
    contents: [
      {
        uri: ROOM_URI,
        mimeType: 'text/html;profile=mcp-app',
        text: roomHtml(),
        _meta: { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } },
      },
    ],
  }),
);
server.registerTool(
  'council_room',
  {
    description:
      'Open the native Council Room. Configure exact per-role models, effort, counts, billing boundaries, output language and evidence. Live admission remains operator-controlled.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: ROOM_URI } },
  },
  async () => text(configuration()),
);
server.registerTool(
  'council_configuration',
  {
    description:
      'Read Council Room configuration without rendering another UI component. No credentials or operator paths.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async () => text(configuration()),
);
server.registerTool(
  'council_preset',
  {
    description:
      'Construct a preset from explicit per-role selections. Keeps skeptic/verifier/chair and chosen pins. No default models or permission expansion.',
    inputSchema: { preset: PresetName, selections: z.array(AgentSchema).max(32) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ preset, selections }) =>
    safe(() => ({ agents: createPreset(preset, selections), permissionScope: 'read_only' })),
);
server.registerTool(
  'council_import_observations',
  {
    description:
      'Validate supplied observations against exact read scope and byte/count bounds. Does not fetch sources or inherit user plugins; provenance remains caller-reported.',
    inputSchema: { scope: ObservationScope, observations: z.array(EvidenceSchema).max(100) },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ scope, observations }) =>
    safe(() => ({ evidence: importObservations(scope, observations) })),
);
server.registerTool(
  'council_run',
  {
    description:
      'Run the evidence-first council. Consumes plan allowance or API funds only when explicitly enabled by trusted operator settings. Never changes external sites or repositories. Same run ID and request are not replayed.',
    inputSchema: { request: RequestSchema },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: true,
    },
  },
  async ({ request }) => safe(() => runtime.engine.run(request)),
);
server.registerTool(
  'council_status',
  {
    description: 'Read the local run receipt and metadata-only event journal.',
    inputSchema: { runId: Identifier },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ runId }) => text({ run: runtime.store.get(runId), events: runtime.store.events(runId) }),
);
server.registerTool(
  'council_cancel',
  {
    description:
      'Cancel a running council in this runtime. Already-dispatched API costs may still be incurred.',
    inputSchema: { runId: Identifier },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  async ({ runId }) => text({ runId, cancelRequested: runtime.engine.cancel(runId) }),
);
server.registerTool(
  'council_inspect_html',
  {
    description:
      'Parse supplied source HTML for titles, canonicals, robots meta, image alt attributes and JSON syntax. Does not fetch pages, render JS, inspect GSC or establish indexing causes.',
    inputSchema: { html: z.string().max(2000000), sourceUrl: z.url() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ html, sourceUrl }) => safe(() => inspectHtml(html, sourceUrl)),
);
await server.connect(new StdioServerTransport());
const shutdown = () => {
  runtime.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('end', shutdown);
