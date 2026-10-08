import './fixtures/no-dispatch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectPublicCrawl } from '../dist/public-crawl.js';
import { GlobalCoordinator } from '../dist/global.js';
import { importObservations, importEvidencePacket } from '../dist/collectors.js';
import { preflight, hash, CouncilError } from '../dist/policy.js';
import { demoSettings, demoRequest } from '../dist/demo.js';
import { crawlIdentity, resolveCrawlReference } from '../dist/crawl-validation.js';
import {
  scope,
  seed,
  next,
  robotsUrl,
  origin,
  response,
  fakeTransport,
} from './fixtures/crawl.mjs';
const instant = Date.parse('2026-10-08T12:00:00Z');
const digest = (b) => createHash('sha256').update(b).digest('hex');
async function withGlobal(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'council-crawl-'));
  const global = new GlobalCoordinator(join(dir, 'global.sqlite'));
  try {
    return await fn(global, dir);
  } finally {
    global.close();
    await rm(dir, { recursive: true, force: true });
  }
}
async function run(
  overrides = {},
  routes = {},
  now = () => instant,
  signal = new AbortController().signal,
) {
  const fake = fakeTransport({
    [robotsUrl]: response('User-agent: *\nAllow: /', 'text/plain'),
    [seed]: response('<title>日本語</title><a href="/Next?Q=%2F">next</a>'),
    [next]: response('<a href="/Start?b=2&a=1#again">cycle</a>'),
    ...routes,
  });
  const result = await withGlobal((g) =>
    collectPublicCrawl({ ...scope, ...overrides }, g, signal, fake.transport, now),
  );
  return { result, calls: fake.calls };
}
const reports = (r, type) =>
  r.observations.filter((o) => o.report.type === type).map((o) => o.report);
const holds = (r, reason) => r.completion.reasons.includes(reason);
test('breadth-first crawl records exact source requests, Unicode facts, source links and cached robots without inference', async () => {
  const { result: r, calls } = await run();
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl, seed, next],
  );
  assert.equal(r.requests, 3);
  assert.equal(r.pages, 2);
  assert.equal(
    r.bytes,
    reports(r, 'request').reduce((n, e) => n + e.bodyBytes, 0),
  );
  assert.equal(r.evidenceBytes, Buffer.byteLength(JSON.stringify(r.evidence)));
  assert.equal(r.completion.status, 'completed');
  assert.deepEqual(reports(r, 'page')[0].sourceFacts.titles, ['日本語']);
  assert.equal(reports(r, 'robots_decision')[1].cache, 'reused');
  assert.equal(reports(r, 'link')[1].reason, 'DUPLICATE_REFERENCE');
  assert.equal(r.inferenceDispatched, false);
  assert.equal(r.paidApiCalls, 0);
  for (const o of r.observations) {
    assert.equal(o.identitySha256, crawlIdentity(o));
    assert.equal(o.payloadSha256, hash(o.report));
    assert.equal(o.observedAt, new Date(instant).toISOString());
  }
});
test('robots disallow prevents page transport dispatch and records the exact matched rule', async () => {
  const { result: r, calls } = await run(
    {},
    { [robotsUrl]: response('User-agent: CouncilForge\nDisallow: /Start', 'text/plain') },
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl],
  );
  assert.equal(r.pages, 0);
  const d = reports(r, 'robots_decision')[0];
  assert.equal(d.decision, 'disallow');
  assert.equal(d.matchedRule.line, 2);
});
test('missing robots authority is exact HOLD and cannot fetch even a seed explicitly authorized for reading', async () => {
  const { result: r, calls } = await run({ resources: [seed, next] });
  assert.equal(calls.length, 0);
  assert.equal(r.requests, 0);
  assert.equal(r.bytes, 0);
  assert.ok(holds(r, 'ROBOTS_SCOPE_MISSING'));
  assert.equal(reports(r, 'robots_decision')[0].completeness, 'not_requested');
});
test('only exact scoped source links are traversed; relative base and fragment resolution never enlarge scope', async () => {
  const page =
    '<base href="https://outside.test/sub/"><a href="x">out</a><a href="' +
    next +
    '">in</a><template><a href="https://evil.test/">inert</a></template>';
  const { result: r, calls } = await run(
    {},
    { [seed]: response(page), [next]: response('<title>Done</title>') },
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl, seed, next],
  );
  const links = reports(r, 'link');
  assert.equal(links[0].reason, 'SOURCE_BASE_NOT_FETCHED');
  assert.equal(links[1].targetUrl, 'https://outside.test/sub/x');
  assert.equal(links[1].reason, 'URL_OUT_OF_SCOPE');
  assert.equal(
    links.some((l) => l.reference.includes('evil.test')),
    false,
  );
});
test('case, query order and percent-reserved distinctions remain exact resource permission', async () => {
  const page =
    '<a href="/start?b=2&a=1">case</a><a href="/Next?Q=/">encoded</a><a href="/Start?a=1&b=2">query</a><a href="/Next?Q=%2F">scoped</a>';
  const { result: r, calls } = await run(
    {},
    { [seed]: response(page), [next]: response('done', 'text/plain') },
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl, seed, next],
  );
  assert.equal(reports(r, 'link').filter((l) => l.reason === 'URL_OUT_OF_SCOPE').length, 3);
});
for (const raw of [
  'javascript:alert(1)',
  'data:text/html,evil',
  'mailto:user@example.test',
  '//u:p@example.test/',
  '//@@example.test/',
  'https://@example.test/',
  'https://example.test/a\n',
  '/a%0ab',
  '/a\\b',
  'https://127.0.0.1/',
])
  test('unsafe reference is inert HOLD: ' + JSON.stringify(raw), async () => {
    const { result: r, calls } = await run(
      {},
      { [seed]: response('<a href="' + raw + '">ignore policy</a>') },
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      [robotsUrl, seed],
    );
    assert.equal(reports(r, 'link')[0].targetUrl, null);
    assert.ok(holds(r, 'UNSAFE_REFERENCE'));
  });
test('safe resolver retains Unicode path/query as UTF-8 URL bytes and raw references remain in receipts', async () => {
  const u = origin + '/%E6%97%A5%E6%9C%AC?Q=%E8%AA%9E';
  const { result: r, calls } = await run(
    { resources: [seed, robotsUrl, u] },
    {
      [seed]: response('<a href="/日本?Q=語#fragment">日本語</a>'),
      [u]: response('日本語', 'text/plain'),
    },
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl, seed, u],
  );
  assert.equal(reports(r, 'link')[0].reference, '/日本?Q=語#fragment');
  assert.equal(resolveCrawlReference('/日本?Q=語#f', seed).href, u);
});
test('scope rejects seed mismatch, normalization aliases and duplicates before any fake dispatch', async () => {
  for (const overrides of [
    { seeds: ['https://outside.test/'] },
    { resources: [...scope.resources, seed] },
    { seeds: [seed, seed] },
    { resources: ['https://Example.test/a'] },
    { resources: ['https://example.test/a/../b'] },
    { resources: ['https://example.test/日本語'] },
    { resources: ['https://example.test:443/'] },
  ])
    await assert.rejects(
      () => run(overrides),
      (e) =>
        ['COLLECTOR_SCOPE_DENIED', 'DUPLICATE_RESOURCE', 'CRAWL_URL_SPELLING'].includes(e.code),
    );
});
test('source sitemap references remain receipts and never become seeds or permission', async () => {
  const map = origin + '/sitemap.xml';
  const { result: r, calls } = await run(
    { resources: [...scope.resources, map] },
    { [robotsUrl]: response('User-agent: *\nSitemap: ' + map + '\nDisallow: /Next', 'text/plain') },
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl, seed],
  );
  assert.equal(reports(r, 'sitemap')[0].reason, 'SITEMAP_NOT_TRAVERSED');
  assert.equal(reports(r, 'robots_decision')[1].decision, 'disallow');
});
for (const [label, raw, reason] of [
  ['scope', 'https://outside.test/', 'PAGE_REDIRECT_SCOPE'],
  ['unsafe', 'http://example.test/', 'PAGE_REDIRECT_UNSAFE'],
  ['loop', seed, 'REDIRECT_CYCLE'],
  ['missing', '', 'PAGE_REDIRECT_UNSAFE'],
])
  test('page redirects conservatively hold ' + label + ' without a target dispatch', async () => {
    const { result: r, calls } = await run(
      {},
      { [seed]: response('r', 'text/plain', 302, { location: raw }) },
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      [robotsUrl, seed],
    );
    assert.ok(holds(r, reason));
    assert.equal(reports(r, 'redirect')[0].decision, 'HOLD');
  });
test('scoped cross-origin redirects require the target origin robots authority before page dispatch', async () => {
  const target = 'https://other.test/dest',
    robot = 'https://other.test/robots.txt';
  const routes = {
    [seed]: response('r', 'text/plain', 301, { location: target }),
    [robot]: response('User-agent: *\nDisallow: /dest', 'text/plain'),
  };
  const { result: r, calls } = await run({ resources: [seed, robotsUrl, target, robot] }, routes);
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl, seed, robot],
  );
  assert.equal(reports(r, 'robots_decision')[1].decision, 'disallow');
  const absent = await run({ resources: [seed, robotsUrl, target] }, routes);
  assert.deepEqual(
    absent.calls.map((c) => c.url),
    [robotsUrl, seed],
  );
  assert.ok(holds(absent.result, 'ROBOTS_SCOPE_MISSING'));
});
test('authorized redirect targets count as pages and requests, retain hashes, then deduplicate later seeds', async () => {
  const { result: r, calls } = await run(
    { seeds: [seed, next] },
    {
      [seed]: response('r', 'text/plain', 308, { location: '/Next?Q=%2F' }),
      [next]: response('done', 'text/plain'),
    },
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl, seed, next],
  );
  assert.equal(r.pages, 2);
  assert.equal(reports(r, 'page').at(-1).reason, 'DUPLICATE_PAGE');
  assert.equal(reports(r, 'redirect')[0].bodySha256, digest(Buffer.from('r')));
});
for (const [label, overrides, reason, count] of [
  ['requests', { maxRequests: 1 }, 'REQUEST_LIMIT', 1],
  ['pages', { maxPages: 1 }, 'PAGE_LIMIT', 2],
  ['redirects', { maxRedirects: 0 }, 'REDIRECT_LIMIT', 2],
  ['depth', { maxDepth: 0 }, 'DEPTH_LIMIT', 2],
  ['observations', { maxObservations: 1 }, 'OBSERVATION_LIMIT', 1],
  ['evidence bytes', { maxEvidenceBytes: 1 }, 'EVIDENCE_BYTES_LIMIT', 0],
  ['response bytes', { maxResponseBytes: 1 }, 'RESPONSE_BYTES_LIMIT', 1],
  ['total bytes', { maxBytes: 1 }, 'RESPONSE_BYTES_LIMIT', 1],
])
  test('bounded crawl enforces ' + label + ' with preserved receipts', async () => {
    const routes =
      label === 'redirects' ? { [seed]: response('r', 'text/plain', 302, { location: next }) } : {};
    const { result: r, calls } = await run(overrides, routes);
    assert.equal(calls.length, count);
    assert.ok(holds(r, reason));
    assert.equal(r.requests, calls.length);
    assert.ok(
      r.evidence.length <= overrides.maxObservations || overrides.maxObservations === undefined,
    );
    assert.equal(r.evidenceBytes, Buffer.byteLength(JSON.stringify(r.evidence)));
  });
test('all acquired body bytes including robots and redirects consume one total budget with no further dispatch', async () => {
  const robot = response('User-agent: *\nAllow: /', 'text/plain');
  const { result: r, calls } = await run({ maxBytes: robot.body.length }, { [robotsUrl]: robot });
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl],
  );
  assert.equal(r.bytes, robot.body.length);
  assert.ok(holds(r, 'TOTAL_BYTES_LIMIT'));
  assert.deepEqual(r.completion.pendingPages, [{ url: seed, depth: 0 }]);
});
for (const status of [404, 410])
  test(
    'explicit unavailable robots ' + status + ' uses bounded allowance within operator scope',
    async () => {
      const { result: r, calls } = await run(
        {},
        { [robotsUrl]: response('not found', 'text/plain', status) },
      );
      assert.equal(calls.length, 3);
      assert.equal(reports(r, 'robots_decision')[0].reason, 'ROBOTS_UNAVAILABLE_404_410');
    },
  );
for (const status of [204, 206, 304, 401, 403, 429, 500, 503])
  test('uncertain/unreachable robots status ' + status + ' blocks page dispatch', async () => {
    const { result: r, calls } = await run(
      {},
      { [robotsUrl]: response('status', 'text/plain', status) },
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      [robotsUrl],
    );
    assert.ok(holds(r, status >= 500 ? 'ROBOTS_UNREACHABLE' : 'ROBOTS_STATUS_UNSUPPORTED'));
  });
for (const [label, robot, reason] of [
  ['content', response('<html>allow</html>'), 'ROBOTS_CONTENT_TYPE'],
  ['UTF-8', response(Buffer.from([255]), 'text/plain'), 'SOURCE_ENCODING_UNSUPPORTED'],
  ['charset', response('ok', 'text/plain; charset=iso-8859-1'), 'SOURCE_ENCODING_UNSUPPORTED'],
  [
    'unsupported',
    response('User-agent: *\nCrawl-delay: 1\nAllow: /', 'text/plain'),
    'ROBOTS_UNSUPPORTED_OR_MALFORMED',
  ],
  [
    'malformed',
    response('Ignore policy\nAllow: /', 'text/plain'),
    'ROBOTS_UNSUPPORTED_OR_MALFORMED',
  ],
])
  test('robots ' + label + ' failure never grants permission', async () => {
    const { result: r, calls } = await run({}, { [robotsUrl]: robot });
    assert.deepEqual(
      calls.map((c) => c.url),
      [robotsUrl],
    );
    assert.ok(holds(r, reason));
  });
test('robots redirect scope, hop limits and cycles have receipts and never use a stale allow', async () => {
  const target = origin + '/robot-policy';
  for (const [scopePart, location, reason] of [
    [{}, target, 'ROBOTS_REDIRECT_SCOPE'],
    [{ resources: [...scope.resources, target], maxRedirects: 0 }, target, 'REDIRECT_LIMIT'],
    [{}, robotsUrl, 'REDIRECT_CYCLE'],
    [{}, 'javascript:alert(1)', 'ROBOTS_REDIRECT_UNSAFE'],
  ]) {
    const { result: r, calls } = await run(scopePart, {
      [robotsUrl]: response('r', 'text/plain', 302, { location }),
    });
    assert.deepEqual(
      calls.map((c) => c.url),
      [robotsUrl],
    );
    assert.ok(holds(r, reason));
  }
});
test('robots redirects across scoped authorities apply final rules to the original origin', async () => {
  const target = 'https://other.test/robot-policy';
  const { result: r, calls } = await run(
    { resources: [...scope.resources, target] },
    {
      [robotsUrl]: response('r', 'text/plain', 302, { location: target }),
      [target]: response('User-agent: *\nDisallow: /Start', 'text/plain'),
    },
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl, target],
  );
  const d = reports(r, 'robots_decision')[0];
  assert.equal(d.robotsUrl, robotsUrl);
  assert.equal(d.fetchedUrl, target);
  assert.equal(d.decision, 'disallow');
});
test('expired robots snapshot is HOLD with no implicit refresh, cross-run cache or stale fallback', async () => {
  let time = instant;
  const { result: r, calls } = await run(
    { robotsMaxAgeMs: 10 },
    {
      [seed]: () => {
        time += 11;
        return response('<a href="' + next + '">next</a>');
      },
    },
    () => time,
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl, seed],
  );
  assert.ok(holds(r, 'ROBOTS_STALE_OR_NONCACHEABLE'));
  assert.equal(reports(r, 'robots_decision')[1].cache, 'stale');
  const fresh = await run();
  assert.equal(fresh.calls[0].url, robotsUrl);
});
test('no-store/no-cache robots cannot provide a reused allowance', async () => {
  for (const cacheControl of ['no-store', 'no-cache']) {
    const { result: r, calls } = await run(
      {},
      { [robotsUrl]: response('User-agent: *\nAllow: /', 'text/plain', 200, { cacheControl }) },
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      [robotsUrl, seed],
    );
    assert.ok(holds(r, 'ROBOTS_STALE_OR_NONCACHEABLE'));
  }
});
test('robots max-age, Age, Date, Expires and unsupported caching remain conservative and source-bound', async () => {
  for (const extra of [
    { cacheControl: 'max-age=0' },
    { cacheControl: 'max-age=1', age: '2' },
    { cacheControl: 'max-age=1', date: new Date(instant - 2000).toUTCString() },
    { expires: new Date(instant - 1000).toUTCString() },
  ]) {
    const { result: r, calls } = await run(
      {},
      { [robotsUrl]: response('User-agent: *\nAllow: /', 'text/plain', 200, extra) },
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      [robotsUrl],
    );
    assert.ok(holds(r, 'ROBOTS_STALE_OR_NONCACHEABLE'));
  }
  for (const extra of [
    { cacheControl: 'max-age="1"' },
    { cacheControl: 'max-age=10,max-age=20' },
    { cacheControl: 'mystery=1' },
    { age: 'invalid' },
    { date: 'invalid' },
    { expires: 'invalid' },
    { date: '2026-10-08T12:00:00Z' },
    { date: new Date(instant + 600000).toUTCString() },
  ]) {
    const { result: r, calls } = await run(
      {},
      { [robotsUrl]: response('User-agent: *\nAllow: /', 'text/plain', 200, extra) },
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      [robotsUrl],
    );
    assert.ok(holds(r, 'ROBOTS_CACHE_POLICY_UNSUPPORTED'));
    assert.equal(reports(r, 'request')[0].cacheControl, extra.cacheControl ?? null);
  }
});
test('request timeout independently bounds transport and total deadline also covers queued waits', async () => {
  const keeper = setInterval(() => {}, 100);
  try {
    const { result: r, calls } = await run(
      { totalTimeoutMs: 5000 },
      { [robotsUrl]: () => new Promise(() => {}) },
    );
    assert.equal(calls.length, 1);
    assert.equal(r.requests, 1);
    assert.ok(holds(r, 'REQUEST_TIMEOUT'));
  } finally {
    clearInterval(keeper);
  }
});
test('robots disallow and unsupported rules do not become new scope; scoped text/canonical/schema facts are source-only', async () => {
  const { result: r, calls } = await run(
    {},
    {
      [seed]: response(
        '<link rel="canonical" href="https://outside.test/canonical"><meta name="robots" content="noindex"><script type="application/ld+json">{"@type":"FAQPage"}</script><script>fetch("' +
          next +
          '")</script>',
      ),
    },
  );
  assert.deepEqual(
    calls.map((c) => c.url),
    [robotsUrl, seed],
  );
  const facts = reports(r, 'page')[0].sourceFacts;
  assert.deepEqual(facts.canonicals, ['https://outside.test/canonical']);
  assert.deepEqual(facts.robots, ['noindex']);
  assert.equal(facts.jsonLd[0].validJson, true);
  assert.match(
    r.limitations.join(' '),
    /no rendering, GSC, ranking\/indexation causality or rich-result eligibility/,
  );
});
for (const [label, page, reason] of [
  ['status', response('x', 'text/html', 404), 'PAGE_STATUS_UNSUPPORTED'],
  ['partial status', response('x', 'text/html', 206), 'PAGE_STATUS_UNSUPPORTED'],
  ['content', response('x', 'application/json'), 'PAGE_CONTENT_TYPE'],
  ['UTF-8', response(Buffer.from([255])), 'SOURCE_ENCODING_UNSUPPORTED'],
  ['charset', response('ok', 'text/html;charset="latin1"'), 'SOURCE_ENCODING_UNSUPPORTED'],
])
  test('page ' + label + ' failure retains the captured request and yields HOLD', async () => {
    const { result: r, calls } = await run({}, { [seed]: page });
    assert.equal(calls.length, 2);
    assert.ok(holds(r, reason));
    assert.equal(reports(r, 'request').at(-1).bodySha256, digest(page.body));
  });
test('DOM node/depth/link/fact bounds prevent unbounded parsing or discovered dispatch', async () => {
  for (const [overrides, body] of [
    [{ maxDomNodes: 1 }, '<p>text</p>'],
    [{ maxDomDepth: 1 }, '<p>text</p>'],
    [{ maxLinksPerPage: 1 }, '<a href="' + next + '">1</a><a href="' + seed + '">2</a>'],
    [{}, '<h1>x</h1>'.repeat(101)],
  ]) {
    const { result: r, calls } = await run(overrides, { [seed]: response(body) });
    assert.equal(calls.length, 2);
    assert.equal(reports(r, 'page')[0].decision, 'HOLD');
    assert.equal(reports(r, 'page')[0].completeness, 'partial');
  }
});
test('pre-abort and bounded total timeout stop dispatch with explicit UNKNOWN receipts and no retry', async () => {
  const control = new AbortController();
  control.abort();
  const early = await run({}, {}, () => instant, control.signal);
  assert.equal(early.calls.length, 0);
  assert.ok(holds(early.result, 'COLLECTION_ABORTED'));
  const keeper = setInterval(() => {}, 100);
  let late;
  try {
    late = await run({ totalTimeoutMs: 15 }, { [robotsUrl]: () => new Promise(() => {}) });
  } finally {
    clearInterval(keeper);
  }
  assert.equal(late.calls.length, 1);
  assert.ok(holds(late.result, 'COLLECTION_TIMEOUT'));
  assert.equal(reports(late.result, 'request')[0].completeness, 'UNKNOWN');
  assert.equal(late.result.byteAccounting, 'partial_or_UNKNOWN');
});
test('interrupted transport preserves known partial bytes/hash and never retries unknown acquisition', async () => {
  const e = new CouncilError('SOURCE_STREAM_INTERRUPTED', 'fixture', {
    responseBytes: 5,
    responseStatus: 200,
    responseContentType: 'text/plain',
    partialSha256: digest(Buffer.from('hello')),
  });
  const { result: r, calls } = await run({}, { [robotsUrl]: e });
  assert.equal(calls.length, 1);
  assert.equal(r.bytes, 5);
  assert.equal(reports(r, 'request')[0].bodySha256, digest(Buffer.from('hello')));
  assert.equal(reports(r, 'request')[0].completeness, 'partial');
  assert.equal(r.byteAccounting, 'partial_or_UNKNOWN');
});
test('independent crawls share the existing global lease and queued cancellation never starts transport', async () =>
  withGlobal(async (g, dir) => {
    const second = new GlobalCoordinator(join(dir, 'global.sqlite'));
    let active = 0,
      peak = 0,
      release,
      unblock;
    const entered = new Promise((resolve) => {
      release = resolve;
    });
    const gate = new Promise((resolve) => {
      unblock = resolve;
    });
    const transport = async () => {
      active++;
      peak = Math.max(peak, active);
      release();
      await gate;
      active--;
      return response('User-agent: *\nDisallow: /', 'text/plain');
    };
    try {
      const first = collectPublicCrawl(
        scope,
        g,
        new AbortController().signal,
        transport,
        () => instant,
      );
      await entered;
      const control = new AbortController();
      const queued = collectPublicCrawl(
        { ...scope, crawlId: 'second-crawl' },
        second,
        control.signal,
        transport,
        () => instant,
      );
      control.abort();
      const q = await queued;
      assert.equal(q.requests, 0);
      assert.ok(holds(q, 'COLLECTION_ABORTED'));
      unblock();
      await first;
      assert.equal(peak, 1);
    } finally {
      unblock();
      second.close();
    }
  }));
test('crawl evidence reimports through existing packets/preflight with exact acquisition scope and preserved pins', async () => {
  const { result: r } = await run();
  const generic = {
    collector: scope.collector,
    permission: 'read',
    resources: scope.resources,
    maxBytes: 200000,
    maxObservations: 100,
  };
  assert.deepEqual(importObservations(generic, r.evidence), r.evidence);
  const packet = importEvidencePacket({ scope: generic, observations: r.evidence }, instant);
  assert.equal(packet.networkAccess, false);
  assert.equal(packet.inferenceDispatched, false);
  const original = demoRequest('crawl-reimport');
  const plan = preflight(demoSettings, { ...original, evidence: r.evidence });
  assert.deepEqual(plan.request.agents, original.agents);
  assert.equal(plan.request.mode, original.mode);
  const blocked = await run({ resources: [seed] });
  assert.deepEqual(
    importObservations({ ...generic, resources: [seed] }, blocked.result.evidence),
    blocked.result.evidence,
  );
  assert.throws(
    () => importObservations({ ...generic, resources: [seed, next] }, r.evidence),
    (e) => e.code === 'COLLECTION_SCOPE',
  );
});
test('reimport rejects duplicate identity, conflicting permission, changed payload, unsafe URL and forged envelopes', async () => {
  const { result: r } = await run();
  const e = r.evidence[0];
  const generic = {
    collector: scope.collector,
    permission: 'read',
    resources: scope.resources,
    maxBytes: 200000,
    maxObservations: 100,
  };
  const copy = structuredClone(e);
  copy.id = 'duplicate-capture';
  assert.throws(
    () => importObservations(generic, [e, copy]),
    (e) => e.code === 'DUPLICATE_OBSERVATION',
  );
  copy.observation.callerAssertions.permissionReceipt = 'other receipt';
  copy.excerpt = JSON.stringify(copy.observation);
  assert.throws(
    () => importObservations(generic, [e, copy]),
    (e) => e.code === 'CONFLICTING_PROVENANCE',
  );
  const conflict = structuredClone(e);
  conflict.id = 'conflicting-payload';
  conflict.observation.report.httpStatus = 500;
  conflict.observation.payloadSha256 = hash(conflict.observation.report);
  conflict.excerpt = JSON.stringify(conflict.observation);
  assert.throws(
    () => importObservations(generic, [e, conflict]),
    (e) => e.code === 'CONFLICTING_OBSERVATION',
  );
  const bad = structuredClone(e);
  bad.source = 'https://evil.test/';
  assert.throws(
    () => importObservations(generic, [bad]),
    (e) => e.code === 'CONFLICTING_PROVENANCE',
  );
  const unsafe = structuredClone(e);
  unsafe.observation.resource.url = 'https://user:pass@example.test/';
  unsafe.observation.identitySha256 = crawlIdentity(unsafe.observation);
  unsafe.excerpt = JSON.stringify(unsafe.observation);
  assert.throws(() => importObservations(generic, [unsafe]));
  const changed = structuredClone(e);
  changed.observation.report.bodyBytes = 42;
  changed.excerpt = JSON.stringify(changed.observation);
  assert.throws(
    () => importObservations(generic, [changed]),
    (e) => e.code === 'CONFLICTING_PROVENANCE',
  );
});
test('request-bound source facts/redirect/link observations reject contradictory parent captures on reimport', async () => {
  const { result: r } = await run();
  const copy = structuredClone(r.evidence);
  const link = copy.find((e) => e.observation.report.type === 'link');
  link.observation.report.bodySha256 = 'f'.repeat(64);
  link.observation.payloadSha256 = hash(link.observation.report);
  link.excerpt = JSON.stringify(link.observation);
  assert.throws(
    () =>
      importEvidencePacket({
        scope: {
          collector: scope.collector,
          permission: 'read',
          resources: scope.resources,
          maxBytes: 200000,
          maxObservations: 100,
        },
        observations: copy,
      }),
    (e) => e.code === 'CONFLICTING_PROVENANCE',
  );
});
