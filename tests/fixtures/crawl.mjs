// Independently constructed non-client fixtures; no live acceptance or benchmark.
export const origin = 'https://example.test';
export const seed = origin + '/Start?b=2&a=1';
export const robotsUrl = origin + '/robots.txt';
export const next = origin + '/Next?Q=%2F';
export const scope = {
  mode: 'bounded_crawl',
  crawlId: 'fixture-crawl',
  collector: 'fixture-public',
  permission: 'read',
  permissionReceipt: 'synthetic-read-authority',
  resources: [seed, robotsUrl, next],
  seeds: [seed],
  maxObservations: 100,
  maxRequests: 20,
  maxPages: 10,
  maxDepth: 3,
  maxRedirects: 5,
  maxBytes: 200000,
  maxResponseBytes: 20000,
  maxEvidenceBytes: 200000,
  timeoutMs: 1000,
  totalTimeoutMs: 10000,
  maxDomNodes: 5000,
  maxDomDepth: 128,
  maxLinksPerPage: 50,
  robotsMaxAgeMs: 60000,
};
export const response = (
  body,
  contentType = 'text/html; charset=utf-8',
  status = 200,
  extra = {},
) => ({
  body: Buffer.isBuffer(body) ? body : Buffer.from(body),
  contentType,
  status,
  ...extra,
});
export function fakeTransport(routes) {
  const calls = [];
  const transport = async (url, maxBytes, timeoutMs, signal) => {
    signal.throwIfAborted();
    calls.push({ url: url.href, maxBytes, timeoutMs });
    const value = routes[url.href];
    if (value === undefined) throw new Error('Unexpected fixture URL: ' + url.href);
    if (value instanceof Error) throw value;
    return typeof value === 'function' ? value(url, signal) : value;
  };
  return { transport, calls };
}
