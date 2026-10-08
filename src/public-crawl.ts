import { createHash } from 'node:crypto';
import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { z } from 'zod';
import { ObservationScope } from './collectors.ts';
import { EvidenceSchema, Identifier, type Evidence } from './schema.ts';
import { CouncilError, fail, hash } from './policy.ts';
import type { GlobalCoordinator } from './global.ts';
import { getPublicPage, withCancellation, type PublicResponse } from './public-network.ts';
import { inspectDom } from './seo.ts';
import { ROBOTS_PRODUCT, parseRobots, decideRobots, type RobotsPolicy } from './robots.ts';
import { CrawlObservationSchema, type CrawlObservation, type CrawlReport } from './crawl-schema.ts';
import { crawlResource, crawlIdentity, resolveCrawlReference } from './crawl-validation.ts';
import { boundJson } from './evidence-validation.ts';

export const PublicCrawlScope = ObservationScope.extend({
  mode: z.literal('bounded_crawl'),
  crawlId: Identifier,
  permissionReceipt: z.string().min(1).max(2000),
  seeds: z.array(z.string().min(1).max(500)).min(1).max(25),
  maxRequests: z.number().int().min(1).max(100),
  maxPages: z.number().int().min(1).max(25),
  maxDepth: z.number().int().min(0).max(10),
  maxRedirects: z.number().int().min(0).max(10),
  maxResponseBytes: z.number().int().min(1).max(200000),
  maxEvidenceBytes: z.number().int().min(1).max(200000),
  timeoutMs: z.number().int().min(1000).max(30000),
  totalTimeoutMs: z.number().int().min(1).max(600000),
  maxDomNodes: z.number().int().min(1).max(20000),
  maxDomDepth: z.number().int().min(1).max(256),
  maxLinksPerPage: z.number().int().min(1).max(100),
  robotsMaxAgeMs: z.number().int().min(1).max(86400000),
}).strict();
type Scope = z.infer<typeof PublicCrawlScope>;
const limitations = [
  'Source HTTP/HTML and local decisions only; no rendering, GSC, ranking/indexation causality or rich-result eligibility.',
  'Exact scope and permission receipts are operator assertions; hashes provide consistency, not authentication.',
  'Robots permission and operator authorization are separate. Links, redirects and sitemaps never grant access.',
  'Bounded robots dialect, not full RFC 9309 conformance. Unsupported rules or acquisition outcomes remain HOLD.',
];
const digest = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const errorReason = (e: unknown, signal: AbortSignal): string =>
  signal.aborted
    ? signal.reason?.name === 'TimeoutError'
      ? 'COLLECTION_TIMEOUT'
      : 'COLLECTION_ABORTED'
    : e instanceof CouncilError
      ? e.code
      : e instanceof Error && e.name === 'TimeoutError'
        ? 'REQUEST_TIMEOUT'
        : 'TRANSPORT_UNKNOWN';

function decode(response: PublicResponse, robots = false): string {
  if (
    !new RegExp(robots ? '^text/plain(?:\\s*;|$)' : '^text/(?:html|plain)(?:\\s*;|$)', 'i').test(
      response.contentType,
    )
  )
    fail(robots ? 'ROBOTS_CONTENT_TYPE' : 'PAGE_CONTENT_TYPE', 'Unsupported source content type.');
  for (const param of response.contentType.split(';').slice(1))
    if (/^\s*charset\b/i.test(param) && !/^\s*charset\s*=\s*(?:utf-?8|"utf-?8")\s*$/i.test(param))
      fail('SOURCE_ENCODING_UNSUPPORTED', 'Only UTF-8 source declarations are supported.');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  } catch {
    return fail('SOURCE_ENCODING_UNSUPPORTED', 'Only complete valid UTF-8 source is supported.');
  }
}
function sourceLinks(text: string, scope: Scope) {
  type Node = DefaultTreeAdapterMap['node'];
  const stack: Array<{ node: Node; depth: number; inert: boolean }> = [
    { node: parse(text), depth: 0, inert: false },
  ];
  const links: string[] = [];
  let nodes = 0,
    base: string | null = null;
  while (stack.length) {
    const { node, depth, inert } = stack.pop()!;
    if (++nodes > scope.maxDomNodes || depth > scope.maxDomDepth)
      fail('DOM_LIMIT', 'Source link parsing exceeded node/depth bounds.');
    if ('tagName' in node && !inert) {
      const href = node.attrs.find((a) => a.name === 'href')?.value;
      if (href !== undefined && node.tagName === 'base' && base === null) base = href;
      if (href !== undefined && ['a', 'area'].includes(node.tagName)) {
        if (links.length === scope.maxLinksPerPage)
          fail('LINK_LIMIT', 'Source links exceed the page bound.');
        links.push(href);
      }
    }
    if ('childNodes' in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        stack.push({ node: node.childNodes[i]!, depth: depth + 1, inert });
    if ('content' in node)
      stack.push({
        node: (node as DefaultTreeAdapterMap['template']).content,
        depth: depth + 1,
        inert: true,
      });
  }
  return { links, base };
}
// Conservative invocation-local snapshot lifetime, not a general HTTP cache.
// Unknown/malformed directives and invalid age/date fields cannot supply an allowance.
function robotLifetime(
  response: PublicResponse,
  maxAgeMs: number,
  nowMs: number,
  requestedMs: number,
) {
  const dateValue = (value: string) => {
    const time = Date.parse(value);
    if (!Number.isFinite(time) || new Date(time).toUTCString() !== value)
      fail(
        'ROBOTS_CACHE_POLICY_UNSUPPORTED',
        'Only exact IMF-fixdate cache timestamps are supported.',
      );
    return time;
  };
  let lifetime = maxAgeMs,
    reusable = true,
    hasMaxAge = false;
  let apparentAge = 0;
  const cacheControl = response.cacheControl ?? '';
  // RFC 9110 OWS is SP/HTAB. Do not erase unsupported octets into an allowance.
  if (/[^\t\x20-\x7e]/.test(cacheControl))
    fail(
      'ROBOTS_CACHE_POLICY_UNSUPPORTED',
      'Only ASCII cache directives and SP/HTAB formatting are supported.',
    );
  for (const raw of cacheControl.split(',')) {
    const part = raw.replace(/^[ \t]+|[ \t]+$/g, '').toLowerCase();
    if (!part) continue;
    if (/^max-age=[0-9]+$/.test(part) && !hasMaxAge) {
      hasMaxAge = true;
      lifetime = Math.min(lifetime, Number(part.slice(8)) * 1000);
    } else if (['no-store', 'no-cache'].includes(part)) reusable = false;
    else if (!['public', 'private', 'must-revalidate', 'no-transform'].includes(part))
      fail('ROBOTS_CACHE_POLICY_UNSUPPORTED', 'Unsupported or malformed cache directive.');
  }
  if (response.age !== undefined) {
    if (!/^[0-9]+$/.test(response.age))
      fail('ROBOTS_CACHE_POLICY_UNSUPPORTED', 'Malformed response age.');
    apparentAge = Number(response.age) * 1000 + Math.max(0, nowMs - requestedMs);
  }
  if (response.date !== undefined) {
    const date = dateValue(response.date);
    if (!Number.isFinite(date) || date > nowMs + 300000)
      fail('ROBOTS_CACHE_POLICY_UNSUPPORTED', 'Invalid response date.');
    apparentAge = Math.max(apparentAge, nowMs - date);
  }
  lifetime -= apparentAge;
  if (response.expires !== undefined && !hasMaxAge) {
    const expires = dateValue(response.expires);
    if (!Number.isFinite(expires)) fail('ROBOTS_CACHE_POLICY_UNSUPPORTED', 'Invalid expiry.');
    lifetime = Math.min(lifetime, expires - nowMs);
  }
  return { lifetime: Math.max(0, lifetime), reusable };
}
type Capture = {
  response: PublicResponse;
  identity: string;
  url: string;
  observedAt: string;
  requestedAt: string;
};
type RobotsSnapshot = {
  policy: RobotsPolicy | null;
  decision: 'allow' | 'HOLD';
  reason: string;
  capture: Capture | null;
  expiresAt: number;
  reused: boolean;
  reusable: boolean;
};
// Scope is operator data. This function is intentionally absent from model/MCP tools.
// Serial breadth-first traversal shares the existing user-wide coordinator, cap one.
export async function collectPublicCrawl(
  rawScope: unknown,
  global: GlobalCoordinator,
  externalSignal: AbortSignal,
  transport = getPublicPage,
  now = () => Date.now(),
) {
  boundJson(rawScope, 200000, 8);
  const scope = PublicCrawlScope.parse(rawScope);
  const allowed = new Set(scope.resources);
  for (const url of scope.resources) crawlResource(url);
  if (allowed.size !== scope.resources.length || new Set(scope.seeds).size !== scope.seeds.length)
    fail('DUPLICATE_RESOURCE', 'Crawl resources and seeds must be unique.');
  for (const seed of scope.seeds) {
    crawlResource(seed);
    if (!allowed.has(seed))
      fail('COLLECTOR_SCOPE_DENIED', 'Crawl seed is outside the exact operator scope.');
  }
  const signal = AbortSignal.any([externalSignal, AbortSignal.timeout(scope.totalTimeoutMs)]);
  const scopeSha256 = hash(scope);
  const evidence: Evidence[] = [],
    observations: CrawlObservation[] = [];
  const reasons = new Set<string>();
  let requests = 0,
    bytes = 0,
    evidenceBytes = 2,
    stopped: string | null = null,
    bytesComplete = true;
  let activePage: { url: string; depth: number } | null = null;
  const visited = new Set<string>(),
    scheduled = new Set(scope.seeds);
  const queue = scope.seeds.map((url) => ({ url, depth: 0, parent: null as string | null }));
  const robots = new Map<string, RobotsSnapshot>();
  const stamp = () => new Date(now()).toISOString();
  const stop = (reason: string) => {
    stopped ??= reason;
    reasons.add(reason);
  };
  function make(
    url: string,
    depth: number,
    parent: string | null,
    report: CrawlReport,
    observedAt = stamp(),
  ): Evidence {
    const body = {
      version: 1 as const,
      adapter: 'public_crawl' as const,
      sourceType: 'source_http' as const,
      basis: 'observed_transport_and_local_decision' as const,
      observedAt,
      resource: { propertyId: null, url },
      callerAssertions: {
        collector: scope.collector,
        permission: 'read' as const,
        permissionReceipt: scope.permissionReceipt,
        exportId: scope.crawlId,
      },
      capture: {
        crawlId: scope.crawlId,
        sequence: observations.length + 1,
        scopeSha256,
        depth,
        parentIdentity: parent,
      },
      report,
      payloadSha256: hash(report),
      limitations,
    };
    const observation = CrawlObservationSchema.parse({
      ...body,
      identitySha256: crawlIdentity(body),
    });
    return EvidenceSchema.parse({
      id: `${scope.crawlId.slice(0, 50)}-${observation.capture.sequence}`,
      source: url,
      observedAt,
      kind: 'crawl',
      excerpt: JSON.stringify(observation),
      observation,
      provenance: {
        collector: scope.collector,
        scope: url,
        permission: 'read',
        sourceReported: false,
        limitations,
      },
    });
  }
  function emit(
    url: string,
    depth: number,
    parent: string | null,
    report: CrawlReport,
    at?: string,
  ) {
    if (observations.length >= scope.maxObservations) {
      stop('OBSERVATION_LIMIT');
      return null;
    }
    let item: Evidence;
    try {
      item = make(url, depth, parent, report, at);
    } catch {
      stop('OBSERVATION_FIELD_LIMIT');
      return null;
    }
    const size = Buffer.byteLength(JSON.stringify(item)) + (evidence.length ? 1 : 0);
    if (evidenceBytes + size > scope.maxEvidenceBytes) {
      stop('EVIDENCE_BYTES_LIMIT');
      return null;
    }
    evidenceBytes += size;
    evidence.push(item);
    const observation = item.observation as CrawlObservation;
    observations.push(observation);
    if (report.decision === 'HOLD') reasons.add(report.reason);
    return observation.identitySha256;
  }
  function requestRoom(url: string, depth: number) {
    if (observations.length >= scope.maxObservations) {
      stop('OBSERVATION_LIMIT');
      return false;
    }
    let reserve: Evidence;
    try {
      reserve = make(url, depth, null, {
        type: 'request',
        purpose: 'page',
        requestedAt: stamp(),
        httpStatus: 599,
        contentType: '\u0000'.repeat(500),
        bodyBytes: Number.MAX_SAFE_INTEGER,
        bodySha256: 'f'.repeat(64),
        cacheControl: '\u0000'.repeat(500),
        age: '\u0000'.repeat(500),
        date: '\u0000'.repeat(500),
        expires: '\u0000'.repeat(500),
        completeness: 'UNKNOWN',
        decision: 'HOLD',
        reason: 'X'.repeat(80),
      });
    } catch {
      stop('OBSERVATION_FIELD_LIMIT');
      return false;
    }
    if (evidenceBytes + Buffer.byteLength(JSON.stringify(reserve)) + 1 > scope.maxEvidenceBytes) {
      stop('EVIDENCE_BYTES_LIMIT');
      return false;
    }
    return true;
  }
  async function fetchOne(
    url: string,
    purpose: 'robots' | 'page',
    depth: number,
    parent: string | null,
  ): Promise<Capture | null> {
    if (stopped) return null;
    if (signal.aborted) {
      stop(errorReason(signal.reason, signal));
      return null;
    }
    if (requests === scope.maxRequests) {
      stop('REQUEST_LIMIT');
      return null;
    }
    if (bytes >= scope.maxBytes) {
      stop('TOTAL_BYTES_LIMIT');
      return null;
    }
    if (!requestRoom(url, depth)) return null;
    const allowance = Math.min(scope.maxResponseBytes, scope.maxBytes - bytes);
    let requestedAt = stamp(),
      dispatched = false;
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(scope.timeoutMs)]);
      const response = await global.use(1, requestSignal, async () => {
        requestSignal.throwIfAborted();
        requestedAt = stamp();
        requests++;
        dispatched = true;
        if (purpose === 'page') visited.add(url);
        return withCancellation(
          transport(crawlResource(url), allowance, scope.timeoutMs, requestSignal),
          requestSignal,
        );
      });
      if (
        !Buffer.isBuffer(response.body) ||
        !Number.isInteger(response.status) ||
        response.status < 100 ||
        response.status > 599 ||
        response.contentType.length > 500 ||
        [response.cacheControl, response.age, response.date, response.expires].some(
          (v) => v !== undefined && (typeof v !== 'string' || v.length > 500),
        )
      )
        fail('TRANSPORT_CONTRACT', 'Transport returned an unsupported response contract.');
      bytes += response.body.length;
      const oversized = response.body.length > allowance;
      const observedAt = stamp();
      const identity = emit(
        url,
        depth,
        parent,
        {
          type: 'request',
          purpose,
          requestedAt,
          httpStatus: response.status,
          contentType: response.contentType,
          bodyBytes: response.body.length,
          cacheControl: response.cacheControl ?? null,
          age: response.age ?? null,
          date: response.date ?? null,
          expires: response.expires ?? null,
          bodySha256: digest(response.body),
          completeness: 'complete',
          decision: oversized ? 'HOLD' : 'observed',
          reason: oversized ? 'RESPONSE_BYTES_LIMIT' : 'HTTP_RESPONSE',
        },
        observedAt,
      );
      if (oversized) {
        stop('RESPONSE_BYTES_LIMIT');
        return null;
      }
      return identity ? { response, identity, url, observedAt, requestedAt } : null;
    } catch (error) {
      const reason = errorReason(error, signal);
      if (dispatched) {
        const d = error instanceof CouncilError ? error.diagnostic : undefined;
        const n = typeof d?.responseBytes === 'number' ? d.responseBytes : null;
        if (n !== null) bytes += n;
        bytesComplete = false; // No complete response-byte accounting after interruption.
        emit(url, depth, parent, {
          type: 'request',
          purpose,
          requestedAt,
          httpStatus: typeof d?.responseStatus === 'number' ? d.responseStatus : null,
          cacheControl: null,
          age: null,
          date: null,
          expires: null,
          contentType:
            typeof d?.responseContentType === 'string' ? d.responseContentType.slice(0, 500) : null,
          bodyBytes: n,
          bodySha256: typeof d?.partialSha256 === 'string' ? d.partialSha256 : null,
          completeness: n === null ? 'UNKNOWN' : 'partial',
          decision: 'HOLD',
          reason,
        });
      }
      stop(reason); // No retry, stale fallback or dispatch with unknown remaining bytes.
      return null;
    }
  }
  function reference(
    capture: Capture,
    depth: number,
    type: 'link' | 'redirect' | 'sitemap',
    raw: string,
    base = capture.url,
    decision: 'queued' | 'follow' | 'skip' | 'HOLD' = 'skip',
    reason = 'REFERENCE_OBSERVED',
  ) {
    let target: string | null = null;
    try {
      if (raw || type !== 'redirect') target = resolveCrawlReference(raw, base).href;
    } catch {
      decision = 'HOLD';
      if (type !== 'redirect') reason = 'UNSAFE_REFERENCE';
    }
    emit(capture.url, depth, capture.identity, {
      type,
      requestIdentity: capture.identity,
      bodySha256: digest(capture.response.body),
      reference: raw.slice(0, 2000).replace(/[\uD800-\uDBFF]$/, ''),
      httpStatus: capture.response.status,
      referenceTruncated: raw.length > 2000,
      targetUrl: target,
      internal: target ? new URL(target).origin === new URL(capture.url).origin : null,
      decision,
      reason,
      completeness: raw.length > 2000 ? 'partial' : 'complete',
    });
    return target;
  }
  async function robotSnapshot(initial: string, depth: number): Promise<RobotsSnapshot> {
    let url = initial,
      redirects = 0;
    const chain = new Set<string>();
    const held = (reason: string, capture: Capture | null = null): RobotsSnapshot => ({
      policy: null,
      decision: 'HOLD',
      reason,
      capture,
      expiresAt: now(),
      reused: false,
      reusable: false,
    });
    while (!stopped) {
      if (!allowed.has(url)) return held('ROBOTS_SCOPE_MISSING');
      chain.add(url);
      const capture = await fetchOne(url, 'robots', depth, null);
      if (!capture) return held(stopped ?? 'ROBOTS_UNKNOWN');
      const response = capture.response;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const raw = response.location ?? '';
        let target: string | null = null;
        try {
          if (raw) target = resolveCrawlReference(raw, url).href;
        } catch {
          /* Receipt below remains HOLD. */
        }
        const reason = !target
          ? 'ROBOTS_REDIRECT_UNSAFE'
          : !allowed.has(target)
            ? 'ROBOTS_REDIRECT_SCOPE'
            : chain.has(target)
              ? 'REDIRECT_CYCLE'
              : redirects >= scope.maxRedirects
                ? 'REDIRECT_LIMIT'
                : 'SCOPED_REDIRECT';
        reference(
          capture,
          depth,
          'redirect',
          raw,
          url,
          reason === 'SCOPED_REDIRECT' ? 'follow' : 'HOLD',
          reason,
        );
        if (reason !== 'SCOPED_REDIRECT' || stopped) return held(reason, capture);
        url = target!;
        redirects++;
        continue;
      }
      let age: number, reusable: boolean;
      try {
        const lifetime = robotLifetime(
          response,
          scope.robotsMaxAgeMs,
          now(),
          Date.parse(capture.requestedAt),
        );
        age = lifetime.lifetime;
        reusable = lifetime.reusable;
      } catch (e) {
        return held(errorReason(e, signal), capture);
      }
      if ([404, 410].includes(response.status))
        return {
          policy: null,
          decision: 'allow',
          reason: 'ROBOTS_UNAVAILABLE_404_410',
          capture,
          expiresAt: now() + age,
          reused: false,
          reusable,
        };
      if (response.status !== 200)
        return held(
          response.status >= 500 ? 'ROBOTS_UNREACHABLE' : 'ROBOTS_STATUS_UNSUPPORTED',
          capture,
        );
      try {
        const policy = parseRobots(decode(response, true));
        for (const ref of policy.sitemaps) {
          if (stopped) break;
          reference(capture, depth, 'sitemap', ref, url, 'skip', 'SITEMAP_NOT_TRAVERSED');
        }
        return {
          policy,
          decision: 'allow',
          reason: 'ROBOTS_PARSED',
          capture,
          expiresAt: now() + age,
          reused: false,
          reusable,
        };
      } catch (e) {
        return held(errorReason(e, signal), capture);
      }
    }
    return held(stopped ?? 'ROBOTS_UNKNOWN');
  }
  async function checkRobots(pageUrl: string, depth: number) {
    const initial = new URL('/robots.txt', pageUrl).href;
    if (!allowed.has(initial)) {
      emit(pageUrl, depth, null, {
        type: 'robots_decision',
        targetUrl: pageUrl,
        robotsUrl: initial,
        fetchedUrl: null,
        requestIdentity: null,
        bodySha256: null,
        decision: 'HOLD',
        reason: 'ROBOTS_SCOPE_MISSING',
        httpStatus: null,
        completeness: 'not_requested',
        cache: 'none',
        expiresAt: null,
        matchedRule: null,
        diagnostics: [],
        diagnosticsTruncated: false,
      });
      return false;
    }
    let snapshot = robots.get(initial);
    const reused = !!snapshot;
    if (!snapshot) {
      snapshot = await robotSnapshot(initial, depth);
      robots.set(initial, snapshot);
    }
    const stale =
      snapshot.decision === 'allow' &&
      (now() >= snapshot.expiresAt || (reused && !snapshot.reusable));
    const result = stale
      ? { decision: 'HOLD' as const, reason: 'ROBOTS_STALE_OR_NONCACHEABLE', matchedRule: null }
      : snapshot.decision === 'HOLD'
        ? { decision: 'HOLD' as const, reason: snapshot.reason, matchedRule: null }
        : snapshot.policy
          ? decideRobots(snapshot.policy, crawlResource(pageUrl))
          : { decision: 'allow' as const, reason: snapshot.reason, matchedRule: null };
    const identity = emit(pageUrl, depth, snapshot.capture?.identity ?? null, {
      type: 'robots_decision',
      targetUrl: pageUrl,
      robotsUrl: initial,
      fetchedUrl: snapshot.capture?.url ?? null,
      requestIdentity: snapshot.capture?.identity ?? null,
      bodySha256: snapshot.capture ? digest(snapshot.capture.response.body) : null,
      httpStatus: snapshot.capture?.response.status ?? null,
      ...result,
      completeness: snapshot.capture ? 'complete' : 'UNKNOWN',
      cache: stale ? 'stale' : reused ? 'reused' : snapshot.capture ? 'fresh' : 'none',
      expiresAt: snapshot.decision === 'allow' ? new Date(snapshot.expiresAt).toISOString() : null,
      diagnostics: snapshot.policy?.diagnostics ?? [],
      diagnosticsTruncated: snapshot.policy?.diagnosticsTruncated ?? false,
    });
    return !!identity && !stopped && result.decision === 'allow';
  }
  async function pageChain(
    start: string,
    depth: number,
    parent: string | null,
  ): Promise<Capture | null> {
    let url = start,
      redirects = 0;
    const chain = new Set<string>();
    while (!stopped) {
      if (visited.has(url)) {
        emit(url, depth, parent, {
          type: 'page',
          requestIdentity: null,
          bodySha256: null,
          httpStatus: null,
          contentType: null,
          decision: 'skip',
          reason: 'DUPLICATE_PAGE',
          completeness: 'not_requested',
          sourceFacts: null,
        });
        return null;
      }
      if (visited.size === scope.maxPages) {
        stop('PAGE_LIMIT');
        return null;
      }
      if (!(await checkRobots(url, depth))) return null;
      chain.add(url);
      const capture = await fetchOne(url, 'page', depth, parent);
      if (!capture) return null;
      const response = capture.response;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        let target: string | null = null;
        try {
          if (response.location) target = resolveCrawlReference(response.location, url).href;
        } catch {
          /* HOLD below. */
        }
        const reason = !target
          ? 'PAGE_REDIRECT_UNSAFE'
          : !allowed.has(target)
            ? 'PAGE_REDIRECT_SCOPE'
            : chain.has(target)
              ? 'REDIRECT_CYCLE'
              : redirects >= scope.maxRedirects
                ? 'REDIRECT_LIMIT'
                : 'SCOPED_REDIRECT';
        reference(
          capture,
          depth,
          'redirect',
          response.location ?? '',
          url,
          reason === 'SCOPED_REDIRECT' ? 'follow' : 'HOLD',
          reason,
        );
        if (reason !== 'SCOPED_REDIRECT' || stopped) return null;
        url = target!;
        redirects++;
        parent = capture.identity;
        continue;
      }
      return capture;
    }
    return null;
  }
  while (queue.length && !stopped) {
    const next = queue.shift()!;
    activePage = { url: next.url, depth: next.depth };
    if (signal.aborted) {
      stop(errorReason(signal.reason, signal));
      break;
    }
    const capture = await pageChain(next.url, next.depth, next.parent);
    if (!capture || stopped) continue;
    try {
      if (capture.response.status !== 200)
        fail('PAGE_STATUS_UNSUPPORTED', 'Only complete 200 source pages are supported.');
      const text = decode(capture.response);
      const html = /^text\/html/i.test(capture.response.contentType);
      const facts = html
        ? inspectDom(text, capture.url, {
            maxDepth: scope.maxDomDepth,
            maxNodes: scope.maxDomNodes,
            maxFacts: 100,
          })
        : null;
      const discovery = html ? sourceLinks(text, scope) : { links: [], base: null };
      emit(capture.url, next.depth, capture.identity, {
        type: 'page',
        requestIdentity: capture.identity,
        bodySha256: digest(capture.response.body),
        decision: 'observed',
        reason: html ? 'SOURCE_HTML_PARSED' : 'SOURCE_TEXT_ONLY',
        httpStatus: capture.response.status,
        contentType: capture.response.contentType,
        completeness: 'complete',
        sourceFacts: facts,
      });
      let base = capture.url;
      if (discovery.base !== null && !stopped) {
        const resolved = reference(
          capture,
          next.depth,
          'link',
          discovery.base,
          base,
          'skip',
          'SOURCE_BASE_NOT_FETCHED',
        );
        if (!resolved) continue;
        base = resolved;
      }
      for (const raw of discovery.links) {
        if (stopped) break;
        let target: string | null = null;
        try {
          target = resolveCrawlReference(raw, base).href;
        } catch {
          /* Explicit receipt below. */
        }
        const reason = !target
          ? 'UNSAFE_REFERENCE'
          : !allowed.has(target)
            ? 'URL_OUT_OF_SCOPE'
            : scheduled.has(target) || visited.has(target)
              ? 'DUPLICATE_REFERENCE'
              : next.depth >= scope.maxDepth
                ? 'DEPTH_LIMIT'
                : 'SCOPED_LINK';
        const decision =
          reason === 'SCOPED_LINK'
            ? 'queued'
            : reason === 'DEPTH_LIMIT' || !target
              ? 'HOLD'
              : 'skip';
        reference(capture, next.depth, 'link', raw, base, decision, reason);
        if (reason === 'SCOPED_LINK' && !stopped) {
          scheduled.add(target!);
          queue.push({ url: target!, depth: next.depth + 1, parent: capture.identity });
        }
      }
    } catch (error) {
      emit(capture.url, next.depth, capture.identity, {
        type: 'page',
        requestIdentity: capture.identity,
        bodySha256: digest(capture.response.body),
        decision: 'HOLD',
        reason: errorReason(error, signal),
        httpStatus: capture.response.status,
        contentType: capture.response.contentType,
        completeness: 'partial',
        sourceFacts: null,
      });
    }
  }
  return {
    scope,
    productToken: ROBOTS_PRODUCT,
    scopeSha256,
    requests,
    pages: visited.size,
    bytes,
    byteAccounting: bytesComplete ? 'complete_responses' : 'partial_or_UNKNOWN',
    evidenceBytes,
    evidence,
    observations,
    completion: {
      status: reasons.size ? 'HOLD' : 'completed',
      reasons: [...reasons],
      stopped,
      pendingPages: [
        ...(stopped && activePage ? [activePage] : []),
        ...queue.map((e) => ({ url: e.url, depth: e.depth })),
      ],
      traversalComplete: !stopped && !reasons.size,
      observedAt: stamp(),
    },
    permissionScope: 'read_only',
    inferenceDispatched: false,
    paidApiCalls: 0,
    limitations,
  };
}
