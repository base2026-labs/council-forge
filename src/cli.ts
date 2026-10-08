import { readFileSync, openSync, readSync, closeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { preflight, CouncilError, fail } from './policy.ts';
import { demoSettings, demoRequest } from './demo.ts';
import { Store } from './store.ts';
import { createEngine, loadSettings, openRuntime, catalogue } from './runtime.ts';
import { discoverOpenRouter } from './adapters/openrouter.ts';
import { inspectHtml } from './seo.ts';
import { Language } from './schema.ts';
import { contracts } from './roles.ts';
import { presetContracts } from './presets.ts';
import { collectPublicPages, PublicPageScope } from './public-pages.ts';
import { openGlobalCoordinator } from './global.ts';
import { importEvidencePacket } from './collectors.ts';
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
async function main() {
  const argv = process.argv.slice(2);
  const flag = argv.indexOf('--language');
  const outputLanguage = flag >= 0 ? Language.parse(argv[flag + 1]) : undefined;
  if (flag >= 0) argv.splice(flag, 2);
  const [command, path, url] = argv;
  const requestFile = () => ({
    ...JSON.parse(readFileSync(path!, 'utf8')),
    ...(outputLanguage ? { outputLanguage } : {}),
  });
  if (command === 'contracts') {
    print({ roles: contracts(), presets: presetContracts() });
    return;
  }
  if (command === 'import-evidence' && path) {
    const fd = openSync(path, 'r');
    try {
      const bytes = Buffer.alloc(200001);
      let length = 0,
        n = 0;
      do {
        n = readSync(fd, bytes, length, bytes.length - length, null);
        length += n;
      } while (n > 0 && length < bytes.length);
      if (length > 200000) fail('COLLECTION_LIMIT', 'Import file exceeds the 200000-byte bound.');
      const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length));
      print(importEvidencePacket(JSON.parse(json)));
    } finally {
      closeSync(fd);
    }
    return;
  }
  if (command === 'demo') {
    const store = new Store();
    try {
      print(
        await createEngine(demoSettings, store).run({
          ...demoRequest('demo-' + randomUUID()),
          ...(outputLanguage ? { outputLanguage } : {}),
        }),
      );
    } finally {
      store.close();
    }
    return;
  }
  if (command === 'models') {
    print(catalogue(loadSettings()));
    return;
  }
  if (command === 'catalogue-openrouter') {
    print(await discoverOpenRouter());
    return;
  }
  if (command === 'inspect-html' && path && url) {
    print(inspectHtml(readFileSync(path, 'utf8'), url));
    return;
  }
  if (command === 'collect-public' && path) {
    const scope = PublicPageScope.parse(JSON.parse(readFileSync(path, 'utf8')));
    const global = openGlobalCoordinator();
    try {
      print(
        await collectPublicPages(
          scope,
          scope.resources,
          global,
          AbortSignal.timeout(scope.maxRequests * scope.timeoutMs),
        ),
      );
    } finally {
      global.close();
    }
    return;
  }
  if (command === 'plan' && path) {
    const p = preflight(loadSettings(), requestFile());
    print({
      status: p.status,
      simulation: p.simulation,
      agents: p.agents,
      maxConcurrency: p.maxConcurrency,
      plannedCalls: p.plannedCalls,
      requestHash: p.requestHash,
      warnings: p.warnings,
      outputLanguage: p.request.outputLanguage,
      permissionScope: p.request.permissionScope,
    });
    return;
  }
  if (command === 'run' && path) {
    const runtime = openRuntime();
    try {
      print(await runtime.engine.run(requestFile()));
    } finally {
      runtime.close();
    }
    return;
  }
  print({
    usage: [
      'demo',
      'models',
      'contracts',
      '--language <BCP47-tag> (optional explicit output language override)',
      'catalogue-openrouter (public metadata GET, no inference)',
      'plan <request.json>',
      'run <request.json> (live inference requires two operator gates)',
      'inspect-html <file.html> <source-url>',
      'import-evidence <packet.json> (supplied exports or generic observations; no network/inference)',
      'collect-public <operator-scope.json> (bounded public HTTPS source GETs, no inference)',
    ],
    status: 'alpha; no live integrations are enabled by default',
  });
}
main().catch((error) => {
  console.error(
    JSON.stringify({
      error: error instanceof CouncilError ? error.code : 'INVALID_CONFIG_OR_RUNTIME',
      message: 'No fallback was attempted. Review local configuration and the project docs.',
    }),
  );
  process.exitCode = 1;
});
