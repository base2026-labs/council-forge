import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { ProviderSettings } from '../schema.ts';
import { OpinionSchema, VerificationSchema, ChairSchema } from '../schema.ts';
import type { Invocation, Completion, Provider } from '../provider.ts';
import { CouncilError, fail } from '../policy.ts';
export interface Rpc {
  request(method: string, params: unknown): Promise<unknown>;
  onEvent(fn: (method: string, params: unknown) => void): () => void;
  close(): void;
}
export class StdioRpc implements Rpc {
  private child: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private listeners = new Set<(method: string, params: unknown) => void>();
  private closed = false;
  private abort: () => void;
  constructor(
    executable: string,
    home: string,
    cwd: string,
    private signal: AbortSignal,
  ) {
    const env: NodeJS.ProcessEnv = { CODEX_HOME: home };
    for (const key of ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TMPDIR', 'TEMP', 'LANG'])
      if (process.env[key]) env[key] = process.env[key];
    this.child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      cwd,
      env,
      stdio: 'pipe',
      shell: false,
    });
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
                new CouncilError('CODEX_RPC_ERROR', 'Codex RPC failed; provider details omitted.'),
              );
            else p?.resolve(message.result);
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
  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new CouncilError('CODEX_CLOSED', 'Codex connection is closed.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ method, id, params }) + '\n');
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
export class CodexLocalProvider implements Provider {
  constructor(private config: ProviderSettings) {}
  async complete(input: Invocation): Promise<Completion> {
    if (!this.config.codexHome || !isAbsolute(this.config.codexHome))
      return fail(
        'ISOLATED_CODEX_HOME_REQUIRED',
        'Configure a dedicated, user-authenticated CODEX_HOME with no plugins, MCP servers or hooks. Never copy auth files.',
      );
    const home = await realpath(this.config.codexHome),
      cwd = await mkdtemp(join(tmpdir(), 'council-forge-'));
    const rpc = new StdioRpc(this.config.codexExecutable ?? 'codex', home, cwd, input.signal);
    try {
      input.signal.throwIfAborted();
      await rpc.request('initialize', {
        clientInfo: {
          name: 'council_forge',
          title: 'Council Forge local OSS',
          version: '0.1.0-alpha.1',
        },
      });
      rpc.notify('initialized', {});
      assertSubscriptionAccount(await rpc.request('account/read', { refreshToken: false }));
      const config = z
        .object({ config: z.record(z.string(), z.unknown()) })
        .parse(await rpc.request('config/read', { includeLayers: false })).config;
      for (const key of ['mcp_servers', 'plugins', 'hooks', 'apps'])
        if (config[key] && Object.keys(Object(config[key])).length)
          fail(
            'UNSAFE_HOST_CONFIG',
            'Dedicated Codex profile must not contain apps, MCP servers, plugins or hooks.',
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
        })
        .parse(
          await rpc.request('thread/start', {
            model: input.agent.model,
            modelProvider: 'openai',
            cwd,
            sandbox: 'readOnly',
            approvalPolicy: 'never',
            ephemeral: true,
          }),
        );
      const actual = started.model;
      if (actual !== input.agent.model)
        fail('MODEL_NOT_ATTESTED', 'App-server did not attest the selected model in thread/start.');
      if ((started.modelProvider ?? started.thread.modelProvider) !== 'openai')
        fail('PROVIDER_MISMATCH', 'The current thread is not using the expected provider.');
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
        .object({ data: z.array(z.unknown()), nextCursor: z.string().nullable().optional() })
        .parse(await rpc.request('mcpServerStatus/list', { limit: 1 }));
      if (mcp.data.length || mcp.nextCursor)
        fail('HOST_TOOLS_ENABLED', 'MCP integrations must be disabled in this dedicated profile.');
      assertSubscriptionAccount(await rpc.request('account/read', { refreshToken: false }));
      let text = '';
      let stop = () => {};
      const completed = new Promise<void>((resolve, reject) => {
        stop = rpc.onEvent((method, raw) => {
          const p = (raw ?? {}) as Record<string, unknown>;
          if (method === 'council/closed') {
            reject(
              new CouncilError(
                'CODEX_CLOSED',
                'Codex connection closed before completed inference.',
              ),
            );
            return;
          }
          if (method === 'model/rerouted') {
            reject(new CouncilError('MODEL_REROUTED', 'The service rerouted the requested model.'));
            rpc.close();
            return;
          }
          if (method === 'account/updated' && p.authMode !== 'chatgpt') {
            reject(new CouncilError('AUTH_CHANGED', 'Authentication mode changed.'));
            rpc.close();
            return;
          }
          if (method === 'item/completed') {
            const item = p.item as { type?: string; text?: string; phase?: string } | undefined;
            if (
              item?.type === 'agentMessage' &&
              item.phase !== 'commentary' &&
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
              reject(
                new CouncilError('UNEXPECTED_TOOL', 'A tool was requested by the local model.'),
              );
              rpc.close();
              return;
            }
          }
          if (method === 'turn/completed') {
            const turn = p.turn as { status?: string } | undefined;
            if (turn?.status === 'completed') resolve();
            else reject(new CouncilError('CODEX_INCOMPLETE', 'Codex did not complete the turn.'));
          }
        });
      });
      // Attach immediately so an early stream error cannot become an unhandled rejection.
      void completed.catch(() => undefined);
      const schema =
        input.phase === 'verify'
          ? VerificationSchema
          : input.phase === 'chair'
            ? ChairSchema
            : OpinionSchema;
      try {
        await rpc.request('turn/start', {
          threadId: started.thread.id,
          input: [{ type: 'text', text: input.prompt }],
          model: input.agent.model,
          ...(input.agent.effort ? { effort: input.agent.effort } : {}),
          approvalPolicy: 'never',
          sandboxPolicy: {
            type: 'readOnly',
            access: { type: 'restricted', includePlatformDefaults: true, readableRoots: [cwd] },
          },
          outputSchema: z.toJSONSchema(schema),
        });
        await completed;
      } finally {
        stop();
      }
      if (!text) fail('EMPTY_COMPLETION', 'Codex completed without a final answer.');
      return {
        text,
        actualModel: actual!,
        requestId: started.thread.id,
        usage: { inputTokens: null, outputTokens: null, costUsd: null },
      };
    } finally {
      rpc.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }
}
