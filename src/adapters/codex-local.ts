import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ProviderSettings } from '../schema.ts';
import {
  OpinionSchema,
  VerificationSchema,
  ChairSchema,
  ObjectionSchema,
  Identifier,
} from '../schema.ts';
import type { Invocation, Completion, Provider } from '../provider.ts';
import { ProviderResponseError } from '../provider.ts';
import {
  NativeReceiptSchema,
  nativeIdentity,
  nativeCount,
  type NativeReceipt,
} from '../native-receipt.ts';
import { CouncilError, fail } from '../policy.ts';
export const ISOLATION_CONFIG = {
  mcp_servers: {},
  plugins: {},
  hooks: {},
  apps: {},
  'features.apps': false,
  'features.plugins': false,
  'features.hooks': false,
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.multi_agent': false,
  'features.computer_use': false,
  'features.browser_use': false,
  'features.browser_use_external': false,
  'features.in_app_browser': false,
  'features.image_generation': false,
  'features.artifact': false,
  'features.unbounded_connection_retries': false,
  web_search: 'disabled',
  service_tier: 'default',
};
interface RequestHooks {
  requested?: (id: number) => void;
  dispatched?: () => void;
  acknowledged?: (result: unknown) => void;
}
export interface Rpc {
  request(method: string, params: unknown, hooks?: RequestHooks): Promise<unknown>;
  onEvent(fn: (method: string, params: unknown) => void): () => void;
  close(): void;
}
export class StdioRpc implements Rpc {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: unknown) => void;
      method: string;
      hooks?: RequestHooks;
    }
  >();
  private listeners = new Set<(method: string, params: unknown) => void>();
  private closed = false;
  private abort: () => void;
  constructor(
    executable: string,
    home: string,
    cwd: string,
    private signal: AbortSignal,
    disabledIntegrations: Record<string, false> = {},
  ) {
    const env: NodeJS.ProcessEnv = { CODEX_HOME: home };
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'LANG'])
      if (process.env[key]) env[key] = process.env[key];
    this.child = spawn(
      executable,
      [
        'app-server',
        '--listen',
        'stdio://',
        ...Object.entries({ ...ISOLATION_CONFIG, ...disabledIntegrations }).flatMap(
          ([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`],
        ),
      ],
      {
        cwd,
        env,
        stdio: 'pipe',
        shell: false,
      },
    );
    this.abort = () => this.close();
    signal.addEventListener('abort', this.abort, { once: true });
    let buffer = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2097152) {
        this.close();
        return;
      }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line) as {
            id?: number;
            method?: string;
            params?: unknown;
            result?: unknown;
            error?: unknown;
          };
          if (message.method && message.id !== undefined) {
            this.child.stdin.write(
              JSON.stringify({
                id: message.id,
                error: {
                  code: -32601,
                  message: 'Council Forge does not grant tool approvals or token refresh requests.',
                },
              }) + '\n',
            );
            continue;
          }
          if (message.id !== undefined) {
            const p = this.pending.get(message.id);
            this.pending.delete(message.id);
            if (message.error)
              p?.reject(
                new CouncilError('CODEX_RPC_ERROR', 'Codex RPC failed; provider details omitted.', {
                  method: p?.method,
                }),
              );
            else if (p) {
              try {
                // Persist the acknowledgement before later messages in this same chunk.
                p.hooks?.acknowledged?.(message.result);
                p.resolve(message.result);
              } catch (error) {
                p.reject(error);
                this.close();
              }
            }
          } else if (message.method)
            for (const listener of this.listeners) listener(message.method, message.params);
        } catch {
          this.close();
        }
      }
    });
    this.child.stderr.on('data', () => {
      /* Never copy raw host diagnostics into council logs. */
    });
    this.child.stdin.on('error', () => this.close());
    this.child.on('error', () => this.close());
    this.child.on('exit', () => this.close());
  }
  request(method: string, params: unknown, hooks?: RequestHooks): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new CouncilError('CODEX_CLOSED', 'Codex connection is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      try {
        hooks?.requested?.(id);
        this.pending.set(id, { resolve, reject, method, hooks });
        this.child.stdin.write(JSON.stringify({ method, id, params }) + '\n');
        hooks?.dispatched?.();
      } catch (error) {
        this.pending.delete(id);
        reject(error);
        this.close();
      }
    });
  }
  notify(method: string, params: unknown) {
    this.child.stdin.write(JSON.stringify({ method, params }) + '\n');
  }
  onEvent(fn: (method: string, params: unknown) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.signal.removeEventListener('abort', this.abort);
    for (const p of this.pending.values())
      p.reject(new CouncilError('CODEX_CLOSED', 'Codex exited or was interrupted.'));
    this.pending.clear();
    for (const listener of this.listeners) listener('council/closed', {});
    this.listeners.clear();
    this.child.kill();
  }
}
const Account = z.object({
  account: z.object({ type: z.string() }).nullable(),
  requiresOpenaiAuth: z.boolean(),
});
const Models = z.object({
  data: z.array(
    z.object({
      model: z.string(),
      displayName: z.string().optional(),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })).optional(),
    }),
  ),
  nextCursor: z.string().nullable().optional(),
});
export function assertSubscriptionAccount(raw: unknown) {
  const a = Account.parse(raw);
  if (a.account?.type !== 'chatgpt' || !a.requiresOpenaiAuth)
    fail(
      'SUBSCRIPTION_AUTH_REQUIRED',
      'A managed ChatGPT account with the OpenAI provider is required. API-key and external-token sessions are refused.',
    );
}
export function safeTurnError(raw: unknown): unknown {
  const codes = new Set([
    'contextWindowExceeded',
    'sessionBudgetExceeded',
    'usageLimitExceeded',
    'rateLimitExceeded',
    'flexUnavailable',
    'serverOverloaded',
    'cyberPolicy',
    'misalignmentPolicyViolation',
    'tooManyDenials',
    'internalServerError',
    'unauthorized',
    'badRequest',
    'threadRollbackFailed',
    'sandboxError',
    'other',
  ]);
  if (typeof raw === 'string') return codes.has(raw) ? raw : null;
  if (!raw || typeof raw !== 'object') return null;
  for (const code of [
    'httpConnectionFailed',
    'responseStreamConnectionFailed',
    'responseStreamDisconnected',
    'responseTooManyFailedAttempts',
    'activeTurnNotSteerable',
  ]) {
    const value = (raw as Record<string, unknown>)[code];
    if (value && typeof value === 'object') {
      const status = (value as Record<string, unknown>).httpStatusCode;
      return {
        code,
        httpStatusCode:
          typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
            ? status
            : null,
      };
    }
  }
  return null;
}
export function nativeOutputSchema(phase: Invocation['phase']) {
  // Structured Outputs requires every property to be required. Optional IDs are nullable.
  const opinion = OpinionSchema.extend({
    objections: z.array(ObjectionSchema.extend({ claimId: Identifier.nullable() })).max(20),
  });
  return z.toJSONSchema(
    phase === 'verify' ? VerificationSchema : phase === 'chair' ? ChairSchema : opinion,
  );
}
export class CodexLocalProvider implements Provider {
  constructor(private config: ProviderSettings) {}
  async complete(input: Invocation): Promise<Completion> {
    let native: NativeReceipt = {
      state: 'requested',
      boundary: 'invocation_requested',
      requestedModel: nativeIdentity(input.agent.model),
      requestedEffort: nativeIdentity(input.agent.effort),
      actualModel: null,
      actualEffort: null,
      threadStartRequestId: null,
      turnStartRequestId: null,
      threadId: null,
      turnId: null,
      inferenceDispatched: false,
      outcome: 'unknown',
      errorCode: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null },
      usageEvidence: {
        source: null,
        cachedInputTokens: null,
        reasoningOutputTokens: null,
        totalTokens: null,
      },
    };
    const emit = (
      state: NativeReceipt['state'],
      boundary: NativeReceipt['boundary'],
      patch: Partial<NativeReceipt> = {},
    ) => {
      native = NativeReceiptSchema.parse({ ...native, ...patch, state, boundary });
      input.onNativeReceipt?.(native);
    };
    let rpc!: StdioRpc;
    let cwd: string | undefined;
    let disabledIntegrations: Record<string, false> = {};
    let turnAccepted = false;
    let threadAttestation: unknown = null;
    try {
      emit('requested', 'invocation_requested');
      if (!this.config.codexHome || !isAbsolute(this.config.codexHome))
        fail(
          'ISOLATED_CODEX_HOME_REQUIRED',
          'Configure an existing user-authenticated CODEX_HOME. Never copy auth files.',
        );
      const home = await realpath(this.config.codexHome!);
      cwd = await mkdtemp(join(tmpdir(), 'council-forge-'));
      rpc = new StdioRpc(this.config.codexExecutable ?? 'codex', home, cwd, input.signal);
      input.signal.throwIfAborted();
      const initialize = async () => {
        await rpc.request('initialize', {
          clientInfo: {
            name: 'council_forge',
            title: 'Council Forge local OSS',
            version: '0.1.0-alpha.3',
          },
        });
        rpc.notify('initialized', {});
        assertSubscriptionAccount(await rpc.request('account/read', { refreshToken: false }));
        return z
          .object({ config: z.record(z.string(), z.unknown()) })
          .parse(await rpc.request('config/read', { includeLayers: false })).config;
      };
      let config = await initialize();
      const configuredMcp = Object.keys(Object(config.mcp_servers ?? {}));
      if (configuredMcp.length) {
        if (configuredMcp.some((name) => !/^[a-zA-Z0-9_-]+$/.test(name)))
          fail(
            'UNSAFE_HOST_CONFIG',
            'An integration name cannot be safely disabled with supported config overrides.',
          );
        disabledIntegrations = Object.fromEntries(
          configuredMcp.map((name) => [`mcp_servers.${name}.enabled`, false]),
        );
        rpc.close();
        rpc = new StdioRpc(
          this.config.codexExecutable ?? 'codex',
          home,
          cwd,
          input.signal,
          disabledIntegrations,
        );
        config = await initialize();
      }
      const effectiveMcp = Object.values(Object(config.mcp_servers ?? {})) as {
        enabled?: boolean;
      }[];
      if (effectiveMcp.some((server) => server.enabled !== false))
        fail(
          'UNSAFE_HOST_CONFIG',
          'Invocation-only isolation did not disable every inherited MCP server.',
        );
      const features = config.features as Record<string, unknown> | undefined;
      for (const [key, value] of Object.entries(ISOLATION_CONFIG)) {
        if (key.startsWith('features.') && features?.[key.slice(9)] !== value)
          fail(
            'HOST_ISOLATION_UNVERIFIED',
            'Effective host configuration did not attest a required disabled feature.',
          );
      }
      if (config.web_search !== 'disabled')
        fail(
          'HOST_ISOLATION_UNVERIFIED',
          'Web search was not disabled by the isolated invocation.',
        );
      const models: z.infer<typeof Models>['data'] = [];
      let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const page = Models.parse(
          await rpc.request('model/list', { limit: 100, includeHidden: false, cursor }),
        );
        models.push(...page.data);
        cursor = page.nextCursor ?? null;
        if (cursor) {
          if (cursors.has(cursor) || cursors.size > 20)
            fail('CATALOGUE_PAGINATION', 'Invalid Codex catalogue pagination.');
          cursors.add(cursor);
        }
      } while (cursor);
      const selected = models.find((m) => m.model === input.agent.model);
      if (!selected)
        fail('MODEL_UNAVAILABLE', 'Requested model is not in the local account catalogue.');
      if (
        input.agent.effort &&
        !selected!.supportedReasoningEfforts?.some((e) => e.reasoningEffort === input.agent.effort)
      )
        fail('UNSUPPORTED_EFFORT', 'Current Codex catalogue does not advertise requested effort.');
      const started = z
        .object({
          thread: z.object({ id: z.string(), modelProvider: z.string().optional() }),
          model: z.string().optional(),
          modelProvider: z.string().optional(),
          reasoningEffort: z.string().nullable().optional(),
          approvalPolicy: z.string().optional(),
          sandbox: z.object({ type: z.string(), networkAccess: z.boolean().optional() }).optional(),
          serviceTier: z.string().nullable().optional(),
        })
        .parse(
          await rpc.request(
            'thread/start',
            {
              model: input.agent.model,
              modelProvider: 'openai',
              cwd,
              sandbox: 'read-only',
              approvalPolicy: 'never',
              ephemeral: true,
              serviceTier: 'default',
              config: { ...ISOLATION_CONFIG, model_reasoning_effort: input.agent.effort },
            },
            {
              requested: (id) =>
                emit('requested', 'thread_requested', { threadStartRequestId: id }),
              acknowledged: (raw) => {
                const out = raw as {
                  thread?: { id?: unknown };
                  model?: unknown;
                  reasoningEffort?: unknown;
                };
                emit('requested', 'thread_acknowledged', {
                  threadId: nativeIdentity(out?.thread?.id),
                  actualModel: nativeIdentity(out?.model),
                  actualEffort: nativeIdentity(out?.reasoningEffort),
                });
              },
            },
          ),
        );
      if (!native.threadId)
        fail('CODEX_THREAD_INVALID', 'Native thread identity was not returned.');
      const actual = started.model;
      if (actual !== input.agent.model)
        fail('MODEL_NOT_ATTESTED', 'App-server did not attest the selected model in thread/start.');
      if ((started.modelProvider ?? started.thread.modelProvider) !== 'openai')
        fail('PROVIDER_MISMATCH', 'The current thread is not using the expected provider.');
      if (started.reasoningEffort !== input.agent.effort)
        fail(
          'EFFORT_NOT_ATTESTED',
          'App-server did not attest the exact requested reasoning effort.',
        );
      if (
        started.approvalPolicy !== 'never' ||
        started.sandbox?.type !== 'readOnly' ||
        started.sandbox.networkAccess === true
      )
        fail(
          'CAPABILITY_NOT_ATTESTED',
          'App-server did not attest read-only permissions with no sandbox network.',
        );
      if (started.serviceTier !== 'default' && started.serviceTier !== null)
        fail('SERVICE_TIER_MISMATCH', 'Ordinary service tier was not attested.');
      const apps = z
        .object({ apps: z.array(z.object({ callable: z.boolean() })) })
        .parse(
          await rpc.request('app/installed', { threadId: started.thread.id, forceRefresh: true }),
        );
      if (apps.apps.some((a) => a.callable))
        fail(
          'HOST_TOOLS_ENABLED',
          'Callable connectors are not allowed in the local alpha adapter.',
        );
      const mcp = z
        .object({
          data: z.array(
            z.object({
              tools: z.record(z.string(), z.unknown()).default({}),
              resources: z.array(z.unknown()).default([]),
              resourceTemplates: z.array(z.unknown()).default([]),
            }),
          ),
          nextCursor: z.string().nullable().optional(),
        })
        .parse(await rpc.request('mcpServerStatus/list', { limit: 100 }));
      if (
        mcp.data.some(
          (server) =>
            Object.keys(server.tools).length ||
            server.resources.length ||
            server.resourceTemplates.length,
        ) ||
        mcp.nextCursor
      )
        fail('HOST_TOOLS_ENABLED', 'MCP integrations must be disabled in this dedicated profile.');
      assertSubscriptionAccount(await rpc.request('account/read', { refreshToken: false }));
      threadAttestation = {
        threadId: started.thread.id,
        model: actual,
        effort: started.reasoningEffort,
        approvalPolicy: started.approvalPolicy,
        sandbox: started.sandbox,
        serviceTier: started.serviceTier,
        callableApps: 0,
        callableMcpTools: 0,
        hostIsolation: ISOLATION_CONFIG,
        disabledIntegrations,
      };
      let text = '';
      let stop = () => {};
      let terminalSeen = false;
      let earlyBytes = 0;
      const early: { method: string; params: Record<string, unknown> }[] = [];
      let handle!: (method: string, p: Record<string, unknown>) => void;
      const completed = new Promise<void>((resolve, reject) => {
        const rejectStream = (error: CouncilError) => {
          emit(
            native.inferenceDispatched ? 'unknown' : 'terminal',
            error.code === 'CODEX_CLOSED' ? 'connection_lost' : 'rejected',
            {
              outcome: native.inferenceDispatched ? 'unknown' : 'not_dispatched',
              errorCode: error.code,
            },
          );
          terminalSeen = true;
          reject(error);
          rpc.close();
        };
        handle = (method, p) => {
          if (terminalSeen) return;
          if (method === 'council/closed') {
            rejectStream(
              new CouncilError(
                'CODEX_CLOSED',
                'Codex connection closed before completed inference.',
              ),
            );
            return;
          }
          if (method === 'account/updated') {
            if (p.authMode !== 'chatgpt')
              rejectStream(new CouncilError('AUTH_CHANGED', 'Authentication mode changed.'));
            return;
          }
          if (
            ![
              'item/completed',
              'item/started',
              'turn/started',
              'turn/completed',
              'model/rerouted',
              'thread/tokenUsage/updated',
              'error',
            ].includes(method)
          )
            return;
          // A connection may deliver events for other turns. Missing identities are
          // also uncorrelated; never use their output, usage, tools or terminal status.
          if (p.threadId !== native.threadId) return;
          const turn = p.turn as
            | { id?: unknown; status?: unknown; error?: { codexErrorInfo?: unknown } }
            | undefined;
          const turnId = method.startsWith('turn/') ? turn?.id : p.turnId;
          if (!native.turnId) {
            earlyBytes += Buffer.byteLength(JSON.stringify(p));
            if (early.length >= 128 || earlyBytes > 2097152) {
              rejectStream(
                new CouncilError(
                  'CODEX_EVENT_OVERFLOW',
                  'Too many events before the native acknowledgement.',
                ),
              );
            } else early.push({ method, params: p });
            return;
          }
          if (turnId !== native.turnId) return;
          if (method === 'model/rerouted') {
            rejectStream(
              new CouncilError('MODEL_REROUTED', 'The service rerouted the requested model.'),
            );
            return;
          }
          if (method === 'error' && p.willRetry !== true) {
            rejectStream(
              new CouncilError(
                'CODEX_STREAM_ERROR',
                'Native stream reported an error; outcome remains uncertain.',
              ),
            );
            return;
          }
          if (method === 'turn/started') emit('in_flight', 'turn_started');
          if (method === 'thread/tokenUsage/updated') {
            const last = (p.tokenUsage as { last?: Record<string, unknown> } | undefined)?.last;
            if (last && typeof last === 'object') {
              const count = (key: string) => nativeCount(last[key]);
              const usage = {
                inputTokens: count('inputTokens'),
                outputTokens: count('outputTokens'),
                costUsd: null,
              };
              const usageEvidence = {
                source: 'thread/tokenUsage/updated:last' as const,
                cachedInputTokens: count('cachedInputTokens'),
                reasoningOutputTokens: count('reasoningOutputTokens'),
                totalTokens: count('totalTokens'),
              };
              if (
                JSON.stringify(usage) !== JSON.stringify(native.usage) ||
                JSON.stringify(usageEvidence) !== JSON.stringify(native.usageEvidence)
              )
                emit('in_flight', 'usage_reported', { usage, usageEvidence });
            }
          }
          if (method === 'item/completed') {
            const item = p.item as { type?: string; text?: string; phase?: string } | undefined;
            if (
              item?.type === 'agentMessage' &&
              (item.phase === 'final_answer' || item.phase === undefined || item.phase === null) &&
              typeof item.text === 'string'
            )
              text = item.text;
          }
          if (method === 'item/started') {
            const item = p.item as { type?: string } | undefined;
            if (
              item?.type &&
              [
                'commandExecution',
                'fileChange',
                'mcpToolCall',
                'dynamicToolCall',
                'webSearch',
              ].includes(item.type)
            ) {
              rejectStream(
                new CouncilError('UNEXPECTED_TOOL', 'A tool was requested by the local model.'),
              );
              return;
            }
          }
          if (method === 'turn/completed') {
            if (!['completed', 'failed', 'interrupted'].includes(String(turn?.status))) {
              rejectStream(
                new CouncilError('CODEX_TERMINAL_INVALID', 'Native terminal status was not valid.'),
              );
              return;
            }
            // Persist at the notification boundary, before resolving or validating output.
            emit('terminal', 'turn_completed', {
              outcome: turn!.status as 'completed' | 'failed' | 'interrupted',
              errorCode: turn!.status === 'completed' ? null : 'CODEX_INCOMPLETE',
            });
            terminalSeen = true;
            if (turn?.status === 'completed') resolve();
            else
              reject(
                new CouncilError('CODEX_INCOMPLETE', 'Codex did not complete the turn.', {
                  turnStatus: turn?.status,
                  codexErrorInfo: safeTurnError(turn?.error?.codexErrorInfo),
                }),
              );
          }
        };
        stop = rpc.onEvent((method, raw) =>
          handle(method, raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}),
        );
      });
      // An early connection failure may occur while turn/start is still pending.
      void completed.catch(() => undefined);
      try {
        await rpc.request(
          'turn/start',
          {
            threadId: started.thread.id,
            input: [{ type: 'text', text: input.prompt }],
            model: input.agent.model,
            ...(input.agent.effort ? { effort: input.agent.effort } : {}),
            approvalPolicy: 'never',
            serviceTierForTurn: 'default',
            sandboxPolicy: { type: 'readOnly', networkAccess: false },
            outputSchema: nativeOutputSchema(input.phase),
          },
          {
            requested: (id) => emit('requested', 'turn_requested', { turnStartRequestId: id }),
            dispatched: () => emit('in_flight', 'turn_dispatched', { inferenceDispatched: true }),
            acknowledged: (raw) => {
              const turnId = nativeIdentity((raw as { turn?: { id?: unknown } })?.turn?.id);
              // Retain the actual acknowledgement even when its identity is unusable.
              emit('acknowledged', 'turn_acknowledged', { turnId });
              turnAccepted = true;
              if (!turnId)
                fail('CODEX_ACK_INVALID', 'Native acknowledgement omitted a valid turn identity.');
              emit('in_flight', 'awaiting_completion');
              for (const event of early) handle(event.method, event.params);
              early.length = 0;
            },
          },
        );
        await completed;
      } finally {
        stop();
      }
      if (!text) fail('EMPTY_COMPLETION', 'Codex completed without a final answer.');
      return {
        text,
        actualModel: actual!,
        requestId: null,
        nativeReceipt: native,
        actualEffort: started.reasoningEffort,
        capabilityReceipt: {
          permissionScope: 'read_only',
          configuredHostIsolation: ISOLATION_CONFIG,
          disabledIntegrations,
          sandbox: started.sandbox,
          callableApps: 0,
          callableMcpTools: 0,
          modelTools: [],
          limitation:
            'Invocation-only feature flags and host sandbox are attested; semantic evidence checks remain fallible.',
        },
        usage: native.usage,
      };
    } catch (error) {
      const code = error instanceof CouncilError ? error.code : 'PROVIDER_OR_SCHEMA_ERROR';
      if (native.state !== 'terminal' && native.state !== 'unknown') {
        emit(
          native.inferenceDispatched ? 'unknown' : 'terminal',
          code === 'CODEX_CLOSED' ? 'connection_lost' : 'rejected',
          { outcome: native.inferenceDispatched ? 'unknown' : 'not_dispatched', errorCode: code },
        );
      }
      const rejected = new ProviderResponseError(error, {
        actualModel: native.actualModel,
        requestId: null,
        usage: native.usage,
        nativeReceipt: native,
      });
      rejected.diagnostic = {
        ...(error instanceof CouncilError ? error.diagnostic : {}),
        inferenceDispatched: native.inferenceDispatched,
        turnAccepted,
        threadAttestation,
        resultKnown:
          !native.inferenceDispatched ||
          (native.state === 'terminal' && native.outcome !== 'unknown'),
      };
      throw rejected;
    } finally {
      rpc?.close();
      if (cwd) await rm(cwd, { recursive: true, force: true });
    }
  }
}
