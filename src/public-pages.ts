import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ObservationScope } from './collectors.ts';
import { EvidenceSchema } from './schema.ts';
import { CouncilError, fail } from './policy.ts';
import type { GlobalCoordinator } from './global.ts';
import { inspectHtml } from './seo.ts';

export const PublicPageScope = ObservationScope.extend({
  maxRequests: z.number().int().min(1).max(25).default(1),
  timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  maxRedirects: z.number().int().min(0).max(3).default(0),
}).strict();
export function publicHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname) ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.localhost')
  )
    fail(
      'PUBLIC_URL_REQUIRED',
      'Only public HTTPS domain URLs without credentials, fragments or custom ports are supported.',
    );
  return url;
}
export function isPublicIpv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [a, b, c] = value.split('.').map(Number) as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}
async function getPage(url: URL, maxBytes: number, timeoutMs: number, signal: AbortSignal) {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  requestSignal.throwIfAborted();
  if (maxBytes < 1) fail('COLLECTION_BYTES_EXCEEDED', 'No response byte allowance remains.');
  // Resolve once, reject private/special answers, then pin the connection to that address.
  // IPv6-only hosts are conservatively unsupported; no proxy env or credentials are used.
  const addresses = await Promise.race([
    lookup(url.hostname, { family: 4, all: true }),
    new Promise<never>((_resolve, reject) =>
      requestSignal.addEventListener('abort', () => reject(requestSignal.reason), { once: true }),
    ),
  ]);
  if (!addresses.length || addresses.some(({ address }) => !isPublicIpv4(address)))
    fail('PRIVATE_NETWORK_DENIED', 'DNS must resolve exclusively to public IPv4 addresses.');
  requestSignal.throwIfAborted();
  return new Promise<{ status: number; location?: string; contentType: string; body: Buffer }>(
    (resolve, reject) => {
      const req = request(
        url,
        {
          method: 'GET',
          agent: false,
          signal: requestSignal,
          headers: {
            'User-Agent': 'CouncilForge/0.1 source-observation',
            Accept: 'text/html,text/plain;q=0.5',
          },
          lookup: (_host, options, callback) => {
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0]!.address, 4);
          },
        },
        (response) => {
          if (
            response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity'
          ) {
            response.destroy();
            req.destroy(
              new CouncilError(
                'SOURCE_ENCODING_UNSUPPORTED',
                'Compressed source responses are unsupported.',
              ),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              const error = new CouncilError(
                'COLLECTION_BYTES_EXCEEDED',
                'Response exceeded the remaining collection byte limit.',
              );
              response.destroy(error);
              req.destroy(error);
            } else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              location: response.headers.location,
              contentType: response.headers['content-type'] ?? '',
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on('error', reject);
      req.setTimeout(timeoutMs, () =>
        req.destroy(
          new CouncilError(
            'COLLECTION_TIMEOUT',
            'Public page request timed out; no retry was attempted.',
          ),
        ),
      );
      req.end();
    },
  );
}
export async function collectPublicPages(
  rawScope: unknown,
  requestedUrls: string[],
  global: GlobalCoordinator,
  signal: AbortSignal,
  transport = getPage,
) {
  const scope = PublicPageScope.parse(rawScope);
  const allowed = new Set(scope.resources.map((value) => publicHttpsUrl(value).href));
  if (
    !requestedUrls.length ||
    requestedUrls.length > scope.maxObservations ||
    new Set(requestedUrls).size !== requestedUrls.length
  )
    fail('COLLECTION_COUNT_EXCEEDED', 'Select unique URLs within the requested page count.');
  for (const value of requestedUrls)
    if (!allowed.has(publicHttpsUrl(value).href))
      fail('COLLECTOR_SCOPE_DENIED', 'URL is outside the explicit operator read scope.');
  let bytes = 0,
    requests = 0;
  const evidence = [],
    observations = [];
  for (const [index, value] of requestedUrls.entries()) {
    let url = publicHttpsUrl(value),
      redirects = 0;
    while (true) {
      signal.throwIfAborted();
      if (!allowed.has(url.href))
        fail('COLLECTOR_SCOPE_DENIED', 'Redirect is outside the explicit read scope.');
      if (++requests > scope.maxRequests)
        fail('COLLECTION_COUNT_EXCEEDED', 'Redirects count toward the request limit.');
      if (bytes >= scope.maxBytes)
        fail('COLLECTION_BYTES_EXCEEDED', 'No response byte allowance remains.');
      const page = await global.use(1, signal, () =>
        transport(url, scope.maxBytes - bytes, scope.timeoutMs, signal),
      );
      bytes += page.body.length;
      if (bytes > scope.maxBytes)
        fail('COLLECTION_BYTES_EXCEEDED', 'Collection exceeded the total byte limit.');
      const observedAt = new Date().toISOString();
      const sha256 = createHash('sha256').update(page.body).digest('hex');
      observations.push({
        source: url.href,
        observedAt,
        status: page.status,
        contentType: page.contentType,
        bytes: page.body.length,
        sha256,
      });
      if (page.status >= 300 && page.status < 400 && page.location) {
        if (++redirects > scope.maxRedirects)
          fail('REDIRECT_DENIED', 'Redirect exceeds the explicit redirect limit.');
        url = publicHttpsUrl(new URL(page.location, url).href);
        continue;
      }
      if (page.status !== 200 || !/^(text\/html|text\/plain)(;|$)/i.test(page.contentType))
        fail(
          'UNSUPPORTED_PAGE_RESPONSE',
          'Only successful HTML/plain text source observations are supported.',
        );
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(page.body);
      } catch {
        return fail('SOURCE_ENCODING_UNSUPPORTED', 'Only valid UTF-8 source is supported.');
      }
      const excerpt = text.slice(0, 20000).replace(/[\uD800-\uDBFF]$/, '');
      const item = EvidenceSchema.parse({
        id: `public-page-${index + 1}`,
        source: url.href,
        observedAt,
        kind: /^text\/html/i.test(page.contentType) ? 'source_html' : 'document',
        excerpt,
        provenance: {
          collector: scope.collector,
          scope: url.href,
          permission: 'read',
          sourceReported: true,
          limitations: [
            'One dated GET source observation; no rendering, GSC or indexation causality.',
            'No automatic link discovery, robots policy audit or SERP query.',
            ...(text.length > 20000
              ? ['Excerpt truncated; full response hash is in observations.']
              : []),
          ],
        },
      });
      evidence.push(item);
      if (item.kind === 'source_html')
        observations[observations.length - 1] = {
          ...observations[observations.length - 1]!,
          ...{ sourceFacts: inspectHtml(text, url.href) },
        };
      break;
    }
  }
  return {
    scope,
    requests,
    bytes,
    evidence,
    observations,
    permissionScope: 'read_only',
    paidApiCalls: 0,
    limitations: [
      'Public IPv4 HTTPS only. Supplied scope is authorization input, not model authority.',
      'A source observation cannot establish Google-selected canonical or explain non-indexation.',
    ],
  };
}
