import { readFileSync, mkdirSync, chmodSync, openSync, closeSync, unlinkSync } from 'node:fs';
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
export function loadSettings(): Settings {
  if (!process.env.COUNCIL_CONFIG) return demoSettings;
  const raw = SettingsSchema.parse(
    JSON.parse(readFileSync(resolve(process.env.COUNCIL_CONFIG), 'utf8')),
  );
  return { ...raw, liveEnabled: raw.liveEnabled && process.env.COUNCIL_LIVE_ENABLED === 'true' };
}
export function catalogue(settings: Settings) {
  return settings.providers.map((p) => ({
    id: p.id,
    kind: p.kind,
    models: p.models.map((m) => ({ id: m.id, label: m.label, efforts: m.efforts })),
    source: 'operator-config; verify availability before live inference',
  }));
}
export function createEngine(settings: Settings, store: Store) {
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
  );
}
export function openRuntime() {
  const settings = loadSettings();
  const directory = resolve(process.env.COUNCIL_DATA_DIR ?? '.council-forge');
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
  try {
    engine = createEngine(settings, store);
  } catch (error) {
    store.close();
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
        unlinkSync(lock);
      }
    },
  };
}
