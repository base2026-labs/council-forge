import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ObservationScope } from './collectors.ts';
import { EvidenceSchema } from './schema.ts';
import { fail } from './policy.ts';
import type { GlobalCoordinator } from './global.ts';
import { inspectHtml } from './seo.ts';
import { publicHttpsUrl, getPublicPage } from './public-network.ts';
export { publicHttpsUrl, isPublicIpv4 } from './public-network.ts';

export const PublicPageScope = ObservationScope.extend({
  maxRequests: z.number().int().min(1).max(25).default(1),
  timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  maxRedirects: z.number().int().min(0).max(3).default(0),
}).strict();
export async function collectPublicPages(
  rawScope: unknown,
  requestedUrls: string[],
  global: GlobalCoordinator,
  signal: AbortSignal,
  transport = getPublicPage,
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
