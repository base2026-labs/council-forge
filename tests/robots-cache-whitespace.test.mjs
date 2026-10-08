import './fixtures/no-dispatch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateHeaderValue } from 'node:http';
import { collectPublicCrawl } from '../dist/public-crawl.js';
import { importEvidencePacket } from '../dist/collectors.js';
import { scope, seed, robotsUrl, next, response, fakeTransport } from './fixtures/crawl.mjs';

const coordinator = {
  use: async (_cap, signal, fn) => {
    signal.throwIfAborted();
    return fn();
  },
};
const instant = Date.parse('2026-10-08T12:00:00Z');
const text = 'User-agent: *\nAllow: /';
const bodySha256 = createHash('sha256').update(text).digest('hex');
const importedScope = {
  collector: scope.collector,
  permission: 'read',
  resources: scope.resources,
  maxObservations: scope.maxObservations,
  maxBytes: scope.maxBytes,
};
const reports = (result, type) => result.observations.filter((o) => o.report.type === type);
async function run(cacheControl, extra = {}, changedScope = scope) {
  const fake = fakeTransport({
    [robotsUrl]: response(text, 'text/plain', 200, { cacheControl, ...extra }),
    [seed]: response('An authorized fixture source page.'),
    [next]: response('A second authorized fixture source page.'),
  });
  const result = await collectPublicCrawl(
    changedScope,
    coordinator,
    new AbortController().signal,
    fake.transport,
    () => instant,
  );
  return { result, calls: fake.calls.map((c) => c.url) };
}

for (const cacheControl of [
  'max-age=60\u00a0',
  '\u00a0max-age=60',
  '\u00a0',
  'public\u00a0',
  '\u00a0public',
  ' \tmax-age=60\u00a0 \t',
  'max-age=\u00a060',
  'max-age=60,\u00a0public',
  'public, \t\u00a0\t, max-age=60',
  'max-age=60\u2003',
  '\ufeffmax-age=60',
  '\u0085',
  'max-age=60\n',
  '\rmax-age=60',
  'public\r\n',
  '\vmax-age=60',
  'max-age=60\f',
  'max-age=60\u0000',
  'public\u007f',
]) {
  test(
    'CF-C2 unsupported Cache-Control syntax prevents dispatch: ' + JSON.stringify(cacheControl),
    async () => {
      const { result, calls } = await run(cacheControl);
      assert.deepEqual(calls, [robotsUrl]);
      assert.equal(result.requests, 1);
      assert.equal(result.pages, 0);
      assert.equal(result.completion.status, 'HOLD');
      assert.equal(result.completion.traversalComplete, false);
      assert.ok(result.completion.reasons.includes('ROBOTS_CACHE_POLICY_UNSUPPORTED'));
      const request = reports(result, 'request')[0];
      assert.equal(request.resource.url, robotsUrl);
      assert.equal(request.report.cacheControl, cacheControl);
      assert.equal(request.report.bodySha256, bodySha256);
      assert.equal(request.report.httpStatus, 200);
      assert.equal(request.observedAt, new Date(instant).toISOString());
      assert.equal(request.report.completeness, 'complete');
      const decision = reports(result, 'robots_decision')[0];
      assert.equal(decision.report.decision, 'HOLD');
      assert.equal(decision.report.reason, 'ROBOTS_CACHE_POLICY_UNSUPPORTED');
      assert.equal(decision.report.requestIdentity, request.identitySha256);
      assert.equal(decision.report.bodySha256, bodySha256);
      assert.equal(decision.report.expiresAt, null);
      const imported = importEvidencePacket(
        { scope: importedScope, observations: result.evidence },
        () => instant,
      );
      assert.deepEqual(imported.evidence, result.evidence);
    },
  );
}

test('CF-C2 NBSP cache values are representable HTTP header bytes', () => {
  for (const value of ['max-age=60\u00a0', '\u00a0max-age=60', '\u00a0', 'public\u00a0'])
    assert.doesNotThrow(() => validateHeaderValue('Cache-Control', value));
});

for (const cacheControl of [
  '',
  ' \t',
  ' \tMaX-aGe=60 \t',
  '\tPUBLIC\t, private,\tMAX-AGE=60, MUST-REVALIDATE\t, no-transform ',
  '\t,\tmax-age=60,\t, public, \t',
])
  test(
    'CF-C2 supported ASCII formatting retains allowance: ' + JSON.stringify(cacheControl),
    async () => {
      const { result, calls } = await run(cacheControl);
      assert.deepEqual(calls, [robotsUrl, seed]);
      assert.equal(result.completion.status, 'completed');
      assert.equal(result.completion.traversalComplete, true);
      assert.equal(reports(result, 'robots_decision')[0].report.decision, 'allow');
      assert.equal(reports(result, 'request')[0].report.cacheControl, cacheControl);
    },
  );

for (const status of [404, 410])
  test(
    'CF-C2 unsupported cache syntax also holds unavailable robots status ' + status,
    async () => {
      const fake = fakeTransport({
        [robotsUrl]: response('', 'text/plain', status, { cacheControl: '\u00a0' }),
        [seed]: response('Unavailable robots cannot hide unsupported cache syntax.'),
      });
      const result = await collectPublicCrawl(
        scope,
        coordinator,
        new AbortController().signal,
        fake.transport,
        () => instant,
      );
      assert.deepEqual(
        fake.calls.map((c) => c.url),
        [robotsUrl],
      );
      assert.equal(result.completion.status, 'HOLD');
      assert.ok(result.completion.reasons.includes('ROBOTS_CACHE_POLICY_UNSUPPORTED'));
    },
  );

for (const cacheControl of ['max-age=60x', 'mystery=1', 'max-age = 60', 'max-age=60, max-age=60'])
  test('CF-C2 malformed/unsupported ASCII cache control stays HOLD: ' + cacheControl, async () => {
    const { result, calls } = await run(cacheControl);
    assert.deepEqual(calls, [robotsUrl]);
    assert.ok(result.completion.reasons.includes('ROBOTS_CACHE_POLICY_UNSUPPORTED'));
  });

for (const cacheControl of [' \tNo-Cache\t, max-age=60 ', '\tNO-STORE\t'])
  test(
    'CF-C2 SP/HTAB does not make noncacheable robots reusable: ' + JSON.stringify(cacheControl),
    async () => {
      const { result, calls } = await run(cacheControl, {}, { ...scope, seeds: [seed, next] });
      assert.deepEqual(calls, [robotsUrl, seed]);
      assert.ok(result.completion.reasons.includes('ROBOTS_STALE_OR_NONCACHEABLE'));
      assert.equal(reports(result, 'robots_decision')[1].report.decision, 'HOLD');
    },
  );

for (const [cacheControl, extra] of [
  ['\tmax-age=0 ', {}],
  [' \tmax-age=60\t', { age: '60' }],
])
  test(
    'CF-C2 SP/HTAB retains stale refusal: ' + JSON.stringify([cacheControl, extra]),
    async () => {
      const { result, calls } = await run(cacheControl, extra);
      assert.deepEqual(calls, [robotsUrl]);
      assert.ok(result.completion.reasons.includes('ROBOTS_STALE_OR_NONCACHEABLE'));
    },
  );
