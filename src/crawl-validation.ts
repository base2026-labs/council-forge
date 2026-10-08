import { fail, hash } from './policy.ts';
import { publicHttpsUrl } from './public-network.ts';
import type { CrawlObservation } from './crawl-schema.ts';
import type { Evidence } from './schema.ts';

// Crawl permission requires exact serialized resources, avoiding URL-parser aliases.
// No percent decoding, query sorting, path case folding or inferred directory scopes.
export function crawlResource(value: string): URL {
  const url = publicHttpsUrl(value);
  if (url.href !== value)
    fail('CRAWL_URL_SPELLING', 'Use the exact serialized HTTPS URL in crawl scope.');
  return url;
}
export function resolveCrawlReference(value: string, base: string) {
  if (
    value.length > 2000 ||
    /[\u0000-\u0020\u007f\\]/.test(value) ||
    /^(?:https:)?\/\/[^/?#]*@/i.test(value) ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  )
    fail('UNSAFE_REFERENCE', 'Reference contains unsafe characters.');
  // Validate raw absolute spelling before WHATWG resolution can erase userinfo/controls.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) publicHttpsUrl(value.split('#', 1)[0]!);
  const url = new URL(value, crawlResource(base));
  url.hash = ''; // Fragment identifies the same source resource; keep the raw reference.
  return crawlResource(url.href);
}
export function crawlIdentity(
  o: Pick<CrawlObservation, 'adapter' | 'sourceType' | 'resource' | 'capture' | 'observedAt'>,
) {
  return hash({
    adapter: o.adapter,
    sourceType: o.sourceType,
    resource: o.resource,
    capture: o.capture,
    observedAt: o.observedAt,
  });
}
export function crawlRequiredResources(o: CrawlObservation): string[] {
  const urls = [o.resource.url];
  if (o.report.type === 'robots_decision' && o.report.requestIdentity !== null) {
    urls.push(o.report.robotsUrl);
    if (o.report.fetchedUrl !== null) urls.push(o.report.fetchedUrl);
  }
  if (
    'targetUrl' in o.report &&
    o.report.targetUrl !== null &&
    ['queued', 'follow'].includes(o.report.decision)
  )
    urls.push(o.report.targetUrl);
  return urls;
}
export function validateCrawlEvidence(evidence: Evidence[]) {
  const seen = new Map<string, CrawlObservation>();
  for (const e of evidence) {
    const o = e.observation;
    if (!o || o.adapter !== 'public_crawl') continue;
    const r = o.report;
    crawlResource(o.resource.url);
    if ('targetUrl' in r && r.targetUrl !== null) crawlResource(r.targetUrl);
    if (r.type === 'robots_decision') {
      crawlResource(r.robotsUrl);
      if (r.fetchedUrl !== null) crawlResource(r.fetchedUrl);
      if (
        r.targetUrl !== o.resource.url ||
        r.robotsUrl !== new URL('/robots.txt', r.targetUrl).href
      )
        fail(
          'CONFLICTING_PROVENANCE',
          'Robots target/initial authority must match its source resource.',
        );
      if (
        r.decision === 'allow' &&
        (r.requestIdentity === null ||
          r.fetchedUrl === null ||
          r.bodySha256 === null ||
          r.completeness !== 'complete' ||
          !['fresh', 'reused'].includes(r.cache) ||
          r.expiresAt === null ||
          Date.parse(r.expiresAt) <= Date.parse(o.observedAt))
      )
        fail(
          'CONFLICTING_PROVENANCE',
          'A robots allowance requires a complete current acquisition binding.',
        );
    }
    if (
      r.type === 'page' &&
      r.decision === 'observed' &&
      (r.requestIdentity === null || r.bodySha256 === null || r.completeness !== 'complete')
    )
      fail('CONFLICTING_PROVENANCE', 'Observed page facts require a complete request binding.');
    if (r.type === 'request' && Date.parse(r.requestedAt) > Date.parse(o.observedAt))
      fail('CONFLICTING_PROVENANCE', 'Request time cannot be after response observation time.');
    if (
      e.source !== o.resource.url ||
      e.kind !== 'crawl' ||
      e.observedAt !== o.observedAt ||
      o.capture.crawlId !== o.callerAssertions.exportId ||
      e.excerpt !== JSON.stringify(o) ||
      o.identitySha256 !== crawlIdentity(o) ||
      o.payloadSha256 !== hash(o.report) ||
      !e.provenance ||
      e.provenance.collector !== o.callerAssertions.collector ||
      e.provenance.scope !== o.resource.url ||
      e.provenance.permission !== 'read' ||
      e.provenance.sourceReported !== false ||
      hash(e.provenance.limitations) !== hash(o.limitations)
    )
      fail('CONFLICTING_PROVENANCE', 'Crawl envelope, capture, payload and identity must agree.');
    const prior = seen.get(o.identitySha256);
    if (prior) {
      if (hash(prior.callerAssertions) !== hash(o.callerAssertions))
        fail('CONFLICTING_PROVENANCE', 'Crawl identity has conflicting permission/provenance.');
      if (prior.payloadSha256 !== o.payloadSha256)
        fail('CONFLICTING_OBSERVATION', 'Crawl identity has conflicting observations.');
      fail('DUPLICATE_OBSERVATION', 'Crawl capture identities must be unique.');
    }
    seen.set(o.identitySha256, o);
  }
  // Cross-reference consistency when both source request and derived decision are supplied.
  // Missing parent records remain a limitation, not fabricated acquisition evidence.
  for (const o of seen.values()) {
    const r = o.report;
    if (!('requestIdentity' in r) || r.requestIdentity === null) continue;
    const parent = seen.get(r.requestIdentity);
    if (
      parent &&
      (parent.report.type !== 'request' ||
        parent.report.bodySha256 !== r.bodySha256 ||
        parent.report.httpStatus !== r.httpStatus ||
        parent.capture.crawlId !== o.capture.crawlId ||
        parent.capture.scopeSha256 !== o.capture.scopeSha256 ||
        (r.type === 'page' && parent.resource.url !== o.resource.url) ||
        (r.type === 'robots_decision' && parent.resource.url !== r.fetchedUrl) ||
        (r.type === 'robots_decision' &&
          r.decision === 'allow' &&
          (parent.report.completeness !== 'complete' ||
            ![200, 404, 410].includes(parent.report.httpStatus ?? 0))) ||
        (r.type === 'page' &&
          r.decision === 'observed' &&
          (parent.report.completeness !== 'complete' || parent.report.httpStatus !== 200)) ||
        (['link', 'redirect', 'sitemap'].includes(r.type) &&
          parent.resource.url !== o.resource.url))
    )
      fail(
        'CONFLICTING_PROVENANCE',
        'Derived observation disagrees with its supplied request capture.',
      );
  }
}
