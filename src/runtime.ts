import {
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  openSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { resolve, join } from 'node:path';
import { SettingsSchema, type Settings } from './schema.ts';
import { CouncilEngine } from './engine.ts';
import { Store } from './store.ts';
import type { Provider } from './provider.ts';
import { MockProvider } from './adapters/mock.ts';
import { CodexLocalProvider } from './adapters/codex-local.ts';
import { OpenAICompatibleProvider } from './adapters/openrouter.ts';
import { JevDecisionRouter } from './adapters/jev.ts';
import { demoSettings } from './demo.ts';
import { openGlobalCoordinator, type GlobalCoordinator } from './global.ts';
export function loadSettings(env: NodeJS.ProcessEnv = process.env): Settings {
  const nativePath = env.PLUGIN_DATA ? join(env.PLUGIN_DATA, 'council.local.json') : undefined;
  const path =
    env.COUNCIL_CONFIG ?? (nativePath && existsSync(nativePath) ? nativePath : undefined);
  if (!path) return demoSettings;
  const content = readFileSync(resolve(path), 'utf8');
  const raw = SettingsSchema.parse(JSON.parse(content));
  let admitted = env.COUNCIL_LIVE_ENABLED === 'true';
  // Portable plugin hosts forward PLUGIN_DATA, not arbitrary parent variables.
  // Only an operator-created admission matching the exact config enables native live work.
  if (!env.COUNCIL_CONFIG && env.PLUGIN_DATA) {
    const admissionPath = join(env.PLUGIN_DATA, 'admission.local.json');
    admitted = false;
    if (existsSync(admissionPath)) {
      const admission = z
        .object({
          liveEnabled: z.literal(true),
          configSha256: z.string().regex(/^[a-f0-9]{64}$/),
          permissionScope: z.literal('read_only'),
        })
        .strict()
        .parse(JSON.parse(readFileSync(admissionPath, 'utf8')));
      admitted = admission.configSha256 === createHash('sha256').update(content).digest('hex');
    }
  }
  return { ...raw, liveEnabled: raw.liveEnabled && admitted };
}
export function catalogue(settings: Settings) {
  return settings.providers.map((p) => ({
    id: p.id,
    kind: p.kind,
    models: p.models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts })),
    source: 'operator-config; verify availability before live inference',
  }));
}
export function createEngine(settings: Settings, store: Store, global?: GlobalCoordinator) {
  const adapters = new Map<string, Provider>();
  for (const p of settings.providers)
    adapters.set(
      p.id,
      p.kind === 'mock'
        ? new MockProvider()
        : p.kind === 'codex-local'
          ? new CodexLocalProvider(p)
          : new OpenAICompatibleProvider(p),
    );
  return new CouncilEngine(
    settings,
    store,
    adapters,
    settings.jev.enabled ? new JevDecisionRouter(settings.jev) : undefined,
    global,
  );
}
export function openRuntime() {
  const settings = loadSettings();
  const directory = resolve(
    process.env.COUNCIL_DATA_DIR ??
      (process.env.PLUGIN_DATA ? join(process.env.PLUGIN_DATA, 'runs') : '.council-forge'),
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const lock = join(directory, 'runtime.lock');
  const fd = openSync(lock, 'wx', 0o600);
  closeSync(fd);
  let store: Store;
  try {
    const path = join(directory, 'state.sqlite');
    store = new Store(path);
    chmodSync(path, 0o600);
    store.recover();
  } catch (error) {
    unlinkSync(lock);
    throw error;
  }
  let engine: CouncilEngine;
  let global: GlobalCoordinator | undefined;
  try {
    if (settings.providers.some((p) => p.kind !== 'mock')) global = openGlobalCoordinator();
    engine = createEngine(settings, store, global);
  } catch (error) {
    store.close();
    global?.close();
    unlinkSync(lock);
    throw error;
  }
  let closed = false;
  return {
    settings,
    store,
    engine,
    close: () => {
      if (!closed) {
        closed = true;
        store.close();
        global?.close();
        unlinkSync(lock);
      }
    },
  };
}
