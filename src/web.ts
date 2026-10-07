import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { preflight } from './policy.ts';
import { demoSettings, demoRequest } from './demo.ts';
import { Store } from './store.ts';
import { loadSettings, createEngine, catalogue } from './runtime.ts';
const settings = loadSettings(),
  csrf = randomUUID(),
  port = Number(process.env.PORT ?? 4317),
  origin = `http://127.0.0.1:${port}`;
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local port');
const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public');
const server = createServer(async (req, res) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (
    req.headers.host !== `127.0.0.1:${port}` ||
    (req.headers.origin && req.headers.origin !== origin)
  ) {
    res.writeHead(403).end();
    return;
  }
  const respond = (code: number, data: unknown) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  try {
    if (req.method === 'GET' && req.url === '/api/config') {
      respond(200, {
        csrf,
        catalogue: catalogue(settings),
        request: demoRequest('ui-' + randomUUID()),
        liveEnabled: false,
        allowedModes: settings.allowedModes,
      });
      return;
    }
    if (req.method === 'POST' && ['/api/plan', '/api/demo'].includes(req.url ?? '')) {
      if (req.headers['x-council-csrf'] !== csrf) {
        respond(403, { error: 'CSRF' });
        return;
      }
      let raw = '';
      for await (const chunk of req) {
        raw += String(chunk);
        if (raw.length > 250000) {
          respond(413, { error: 'TOO_LARGE' });
          return;
        }
      }
      const request = JSON.parse(raw) as unknown;
      if (req.url === '/api/plan') {
        const p = preflight(settings, request);
        respond(200, {
          status: p.status,
          agents: p.agents,
          maxConcurrency: p.maxConcurrency,
          plannedCalls: p.plannedCalls,
          warnings: p.warnings,
        });
        return;
      }
      const p = preflight(demoSettings, request);
      if (!p.simulation) {
        respond(403, { error: 'UI_IS_OFFLINE_ONLY' });
        return;
      }
      const store = new Store();
      try {
        respond(200, await createEngine(demoSettings, store).run(request));
      } finally {
        store.close();
      }
      return;
    }
    const files: Record<string, [string, string]> = {
      '/': ['index.html', 'text/html'],
      '/app.js': ['app.js', 'text/javascript'],
      '/style.css': ['style.css', 'text/css'],
    };
    const target = files[req.url ?? ''];
    if (req.method !== 'GET' || !target) {
      respond(404, { error: 'NOT_FOUND' });
      return;
    }
    res.writeHead(200, { 'Content-Type': target[1] });
    res.end(await readFile(join(publicDir, target[0])));
  } catch {
    if (!res.headersSent)
      respond(400, {
        error: 'INVALID_INPUT',
        message:
          'Check the council configuration. No live inference endpoint exists in this planning UI.',
      });
    else res.end();
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`Council Forge offline planning console: ${origin}`),
);
