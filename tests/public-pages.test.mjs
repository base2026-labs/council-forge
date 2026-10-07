import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectPublicPages, publicHttpsUrl, isPublicIpv4 } from '../dist/public-pages.js';
import { GlobalCoordinator } from '../dist/global.js';
const source = 'https://example.test/日本語';
const scope = {
  collector: 'public-source',
  permission: 'read',
  resources: [source],
  maxObservations: 1,
  maxRequests: 1,
  maxBytes: 10000,
};
async function withCoordinator(fn) {
  const root = await mkdtemp(join(tmpdir(), 'council-page-'));
  const global = new GlobalCoordinator(join(root, 'global.sqlite'));
  try {
    await fn(global);
  } finally {
    global.close();
    await rm(root, { recursive: true, force: true });
  }
}
test('public source URL boundary rejects credentials, local hosts, IPs, ports and non-HTTPS', () => {
  for (const value of [
    'http://example.com/',
    'https://user:pass@example.com/',
    'https://127.0.0.1/',
    'https://[::1]/',
    'https://localhost/',
    'https://x.localhost/',
    'https://example.com:8080/',
    'https://example.com/#fragment',
  ])
    assert.throws(() => publicHttpsUrl(value));
  assert.equal(publicHttpsUrl(source).protocol, 'https:');
  for (const value of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.168.1.1',
    '198.18.0.1',
    '192.0.2.1',
    '203.0.113.1',
    '224.0.0.1',
    '::1',
  ])
    assert.equal(isPublicIpv4(value), false, value);
  assert.equal(isPublicIpv4('1.1.1.1'), true);
});
test('bounded collector records Unicode source, provenance and full-byte hash without inference', () =>
  withCoordinator(async (global) => {
    const body = Buffer.from('<html><head><title>日本語</title></head><body>証拠</body></html>');
    const result = await collectPublicPages(
      scope,
      [source],
      global,
      AbortSignal.timeout(3000),
      async () => ({ status: 200, contentType: 'text/html; charset=utf-8', body }),
    );
    assert.equal(result.requests, 1);
    assert.equal(result.bytes, body.length);
    assert.match(result.evidence[0].excerpt, /証拠/);
    assert.equal(result.evidence[0].provenance.permission, 'read');
    assert.match(result.observations[0].sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.paidApiCalls, 0);
    assert.match(result.limitations.join(' '), /non-indexation/);
  }));
test('collector denies scope expansion and redirects before a second network operation', () =>
  withCoordinator(async (global) => {
    let calls = 0;
    const transport = async () => {
      calls++;
      return {
        status: 302,
        location: 'https://outside.test/',
        contentType: 'text/html',
        body: Buffer.from('redirect'),
      };
    };
    await assert.rejects(
      () =>
        collectPublicPages(
          scope,
          ['https://outside.test/'],
          global,
          AbortSignal.timeout(3000),
          transport,
        ),
      (e) => e.code === 'COLLECTOR_SCOPE_DENIED',
    );
    assert.equal(calls, 0);
    await assert.rejects(
      () =>
        collectPublicPages(
          { ...scope, maxRedirects: 1, maxRequests: 2 },
          [source],
          global,
          AbortSignal.timeout(3000),
          transport,
        ),
      (e) => e.code === 'COLLECTOR_SCOPE_DENIED',
    );
    assert.equal(calls, 1);
  }));
test('collector refuses excess bytes and invalid encoding instead of accepting partial evidence', () =>
  withCoordinator(async (global) => {
    await assert.rejects(
      () =>
        collectPublicPages(
          { ...scope, maxBytes: 2 },
          [source],
          global,
          AbortSignal.timeout(3000),
          async () => ({ status: 200, contentType: 'text/html', body: Buffer.from('long') }),
        ),
      (e) => e.code === 'COLLECTION_BYTES_EXCEEDED',
    );
    await assert.rejects(
      () =>
        collectPublicPages(scope, [source], global, AbortSignal.timeout(3000), async () => ({
          status: 200,
          contentType: 'text/html',
          body: Buffer.from([0xff]),
        })),
      (e) => e.code === 'SOURCE_ENCODING_UNSUPPORTED',
    );
  }));
