import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { preflight, CouncilError } from './policy.ts';
import { demoSettings, demoRequest } from './demo.ts';
import { Store } from './store.ts';
import { createEngine, loadSettings, openRuntime, catalogue } from './runtime.ts';
import { discoverOpenRouter } from './adapters/openrouter.ts';
import { inspectHtml } from './seo.ts';
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));
async function main() {
  const [command, path, url] = process.argv.slice(2);
  if (command === 'demo') {
    const store = new Store();
    try {
      print(await createEngine(demoSettings, store).run(demoRequest('demo-' + randomUUID())));
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
  if (command === 'plan' && path) {
    const p = preflight(loadSettings(), JSON.parse(readFileSync(path, 'utf8')));
    print({
      status: p.status,
      simulation: p.simulation,
      agents: p.agents,
      maxConcurrency: p.maxConcurrency,
      plannedCalls: p.plannedCalls,
      requestHash: p.requestHash,
      warnings: p.warnings,
    });
    return;
  }
  if (command === 'run' && path) {
    const runtime = openRuntime();
    try {
      print(await runtime.engine.run(JSON.parse(readFileSync(path, 'utf8'))));
    } finally {
      runtime.close();
    }
    return;
  }
  print({
    usage: [
      'demo',
      'models',
      'catalogue-openrouter (public metadata GET, no inference)',
      'plan <request.json>',
      'run <request.json> (live inference requires two operator gates)',
      'inspect-html <file.html> <source-url>',
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
