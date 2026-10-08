import './fixtures/no-dispatch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPublicTransport, publicHttpsUrl, isPublicIpv4 } from '../dist/public-network.js';
import { collectPublicCrawl } from '../dist/public-crawl.js';
import { scope } from './fixtures/crawl.mjs';
const url = new URL('https://example.test/Source?query=Exact');
function ports({
  addresses = [{ address: '1.1.1.1', family: 4 }],
  chunks = [Buffer.from('source')],
  headers = { 'content-type': 'text/plain' },
  complete = true,
  interrupted = false,
  hanging = false,
} = {}) {
  let resolutions = 0,
    connections = 0,
    options,
    chosen,
    destroyed = false;
  return {
    lookup: async (host, args) => {
      resolutions++;
      assert.equal(host, url.hostname);
      assert.deepEqual(args, { family: 4, all: true });
      return addresses;
    },
    request: (resource, opts, callback) => {
      connections++;
      options = opts;
      assert.equal(resource.href, url.href);
      const req = new EventEmitter();
      req.setTimeout = () => req;
      req.destroy = (e) => {
        destroyed = true;
        if (e) queueMicrotask(() => req.emit('error', e));
      };
      const abort = () => req.destroy(new Error('Aborted fixture connection'));
      opts.signal.addEventListener('abort', abort, { once: true });
      req.end = () => {
        opts.lookup(resource.hostname, { all: true }, (e, address) => {
          assert.equal(e, null);
          chosen = address;
        });
        queueMicrotask(() => {
          if (hanging) return;
          const res = new EventEmitter();
          res.headers = headers;
          res.statusCode = 200;
          res.complete = complete;
          res.destroy = () => {
            destroyed = true;
          };
          callback(res);
          if (!destroyed)
            for (const chunk of chunks) {
              res.emit('data', chunk);
              if (destroyed) break;
            }
          if (!destroyed) {
            if (interrupted) res.emit('aborted');
            else res.emit('end');
          }
          opts.signal.removeEventListener('abort', abort);
        });
      };
      return req;
    },
    state: () => ({ resolutions, connections, options, chosen, destroyed }),
  };
}
test('public transport resolves once and pins one public IPv4 address without a proxy, agent, credential or second resolution', async () => {
  const fake = ports({
    addresses: [
      { address: '1.1.1.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ],
  });
  const transport = createPublicTransport(fake);
  const result = await transport(url, 100, 1000, new AbortController().signal);
  const s = fake.state();
  assert.equal(s.resolutions, 1);
  assert.equal(s.connections, 1);
  assert.deepEqual(s.chosen, [{ address: '1.1.1.1', family: 4 }]);
  assert.equal(s.options.agent, false);
  assert.equal(s.options.method, 'GET');
  assert.equal(s.options.headers['Accept-Encoding'], 'identity');
  assert.match(s.options.headers['User-Agent'], /CouncilForge/);
  assert.equal(s.options.maxHeaderSize, 8192);
  assert.equal(s.options.headers.Authorization, undefined);
  assert.equal(result.body.toString(), 'source');
  let selected;
  s.options.lookup(url.hostname, {}, (e, address, family) => {
    assert.equal(e, null);
    assert.equal(family, 4);
    selected = address;
  });
  assert.equal(selected, '1.1.1.1');
  assert.equal(fake.state().resolutions, 1);
});
for (const address of [
  '10.0.0.1',
  '127.0.0.1',
  '100.64.0.1',
  '169.254.169.254',
  '192.0.2.1',
  '198.18.0.1',
  '203.0.113.1',
  '224.0.0.1',
  '::1',
  '::ffff:1.1.1.1',
])
  test('unsafe DNS answer prevents HTTPS dispatch: ' + address, async () => {
    const fake = ports({ addresses: [{ address, family: 4 }] });
    await assert.rejects(
      () => createPublicTransport(fake)(url, 100, 1000, new AbortController().signal),
      (e) => e.code === 'PRIVATE_NETWORK_DENIED',
    );
    assert.equal(fake.state().connections, 0);
    assert.equal(isPublicIpv4(address), false);
  });
test('mixed public/private and empty DNS answers are rejected before connecting', async () => {
  for (const addresses of [
    [],
    [
      { address: '1.1.1.1', family: 4 },
      { address: '10.1.2.3', family: 4 },
    ],
  ]) {
    const fake = ports({ addresses });
    await assert.rejects(
      () => createPublicTransport(fake)(url, 100, 1000, new AbortController().signal),
      (e) => e.code === 'PRIVATE_NETWORK_DENIED',
    );
    assert.equal(fake.state().connections, 0);
  }
});
test('DNS cancellation and failure cannot fall back to an unpinned request', async () => {
  let connections = 0;
  const control = new AbortController();
  const transport = createPublicTransport({
    lookup: async () => new Promise(() => {}),
    request: () => {
      connections++;
      throw new Error('Forbidden');
    },
  });
  const promise = transport(url, 100, 1000, control.signal);
  control.abort();
  await assert.rejects(() => promise);
  assert.equal(connections, 0);
  await assert.rejects(() =>
    createPublicTransport({
      lookup: async () => {
        throw new Error('DNS fixture error');
      },
      request: () => {
        connections++;
      },
    })(url, 100, 1000, new AbortController().signal),
  );
  assert.equal(connections, 0);
});
test('response-byte overflow retains bounded prefix and exact partial hash instead of accepting the response', async () => {
  const fake = ports({ chunks: [Buffer.from('abc'), Buffer.from('defgh')] });
  await assert.rejects(
    () => createPublicTransport(fake)(url, 5, 1000, new AbortController().signal),
    (e) => {
      assert.equal(e.code, 'COLLECTION_BYTES_EXCEEDED');
      assert.equal(e.diagnostic.responseBytes, 8);
      assert.equal(e.diagnostic.retainedBytes, 5);
      assert.equal(
        e.diagnostic.partialSha256,
        '36bbe50ed96841d10443bcb670d6554f0a34b761be67ec9c4a8ad2c0c44ca42c',
      );
      return true;
    },
  );
  assert.equal(fake.state().destroyed, true);
});
test('compressed, incomplete and interrupted source streams are held with no retry', async () => {
  for (const [options, code] of [
    [
      { headers: { 'content-encoding': 'gzip', 'content-type': 'text/html' } },
      'SOURCE_ENCODING_UNSUPPORTED',
    ],
    [{ complete: false }, 'SOURCE_STREAM_INTERRUPTED'],
    [{ interrupted: true }, 'SOURCE_STREAM_INTERRUPTED'],
  ]) {
    const fake = ports(options);
    await assert.rejects(
      () => createPublicTransport(fake)(url, 100, 1000, new AbortController().signal),
      (e) => e.code === code,
    );
    assert.equal(fake.state().connections, 1);
  }
});
test('connection cancellation aborts the pinned request and does not retry', async () => {
  const fake = ports({ hanging: true });
  const control = new AbortController();
  const promise = createPublicTransport(fake)(url, 100, 1000, control.signal);
  await new Promise((resolve) => setImmediate(resolve));
  control.abort();
  await assert.rejects(() => promise);
  assert.equal(fake.state().connections, 1);
  assert.equal(fake.state().destroyed, true);
});
test('raw controls, backslashes, empty userinfo and percent-encoded controls are rejected before normalization', () => {
  for (const value of [
    'https://@example.test/',
    'https://example.test/a\n',
    'https://example.test/a%00',
    'https://example.test/a\\b',
    'https:example.test/a',
  ])
    assert.throws(
      () => publicHttpsUrl(value),
      (e) => e.code === 'PUBLIC_URL_REQUIRED',
    );
});
test('real collector port reports DNS-denied request accounting without any HTTPS dispatch', async () => {
  const fake = ports({ addresses: [{ address: '10.0.0.1', family: 4 }] });
  const result = await collectPublicCrawl(
    scope,
    { use: async (_limit, _signal, fn) => fn() },
    new AbortController().signal,
    createPublicTransport(fake),
  );
  assert.equal(fake.state().connections, 0);
  assert.equal(result.requests, 1);
  assert.ok(result.completion.reasons.includes('PRIVATE_NETWORK_DENIED'));
  assert.equal(result.byteAccounting, 'partial_or_UNKNOWN');
  assert.equal(result.observations[0].report.bodyBytes, null);
});
