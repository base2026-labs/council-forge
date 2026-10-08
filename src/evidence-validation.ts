import { fail, hash } from './policy.ts';
import type { Evidence } from './schema.ts';
import { DocumentUrl, type TypedObservation } from './evidence-schema.ts';
import { crawlRequiredResources, validateCrawlEvidence } from './crawl-validation.ts';
import type { CrawlObservation } from './crawl-schema.ts';

// Walk before parsing schemas or hashing. No recursion, getters, toJSON or coercion.
export function boundJson(value: unknown, maxBytes: number, maxDepth: number, maxNodes = 20000) {
  const stack: Array<{ value: unknown; depth: number; exit?: boolean }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0,
    bytes = 0;
  while (stack.length) {
    const entry = stack.pop()!;
    if (entry.exit) {
      seen.delete(entry.value as object);
      continue;
    }
    if (++nodes > maxNodes || entry.depth > maxDepth)
      fail('COLLECTION_LIMIT', 'Data exceeds the depth/node bound.');
    const v = entry.value;
    if (v === null || typeof v === 'boolean') bytes += JSON.stringify(v).length;
    else if (typeof v === 'string') bytes += Buffer.byteLength(JSON.stringify(v));
    else if (typeof v === 'number' && Number.isFinite(v)) bytes += String(v).length;
    else if (typeof v === 'object') {
      if (seen.has(v)) fail('INVALID_EXPORT', 'Only acyclic JSON data is accepted.');
      seen.add(v);
      stack.push({ value: v, depth: entry.depth, exit: true });
      if (
        Array.isArray(v)
          ? Object.getPrototypeOf(v) !== Array.prototype
          : Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null
      )
        fail('INVALID_EXPORT', 'Only plain JSON containers are accepted.');
      const entries = Object.entries(Object.getOwnPropertyDescriptors(v));
      if (entries.length > maxNodes || stack.length + entries.length > maxNodes)
        fail('COLLECTION_LIMIT', 'Data exceeds the node bound.');
      bytes += 2;
      let count = 0;
      for (const [key, descriptor] of entries) {
        if (Array.isArray(v) && key === 'length') continue;
        if (
          !('value' in descriptor) ||
          ['__proto__', 'constructor', 'prototype', 'toJSON'].includes(key)
        )
          fail('INVALID_EXPORT', 'Accessors and executable/prototype keys are forbidden.');
        if (!descriptor.enumerable) continue;
        if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key))
          fail('INVALID_EXPORT', 'Arrays must contain only JSON indices.');
        if (count++) bytes++;
        if (!Array.isArray(v)) bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
        stack.push({ value: descriptor.value, depth: entry.depth + 1 });
      }
      if (Array.isArray(v) && (v.length > maxNodes || count !== v.length))
        fail('COLLECTION_LIMIT', 'Sparse or oversized arrays are not accepted.');
    } else fail('INVALID_EXPORT', 'Only finite JSON values are accepted.');
    if (bytes > maxBytes) fail('COLLECTION_LIMIT', 'Data exceeds the authorized byte bound.');
  }
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes)
    fail('COLLECTION_LIMIT', 'Data exceeds the authorized byte bound.');
}
// Validate inert identifier syntax before parsed membership, without rewriting the URL.
// Scope/provenance/hashes remain caller assertions, not proof of property ownership.
export function validateGscPropertyUrl(property: string, url: string) {
  const u = new URL(DocumentUrl.parse(url));
  let within: boolean;
  if (property.startsWith('sc-domain:')) {
    const host = property.slice(10).toLowerCase();
    within = u.hostname === host || u.hostname.endsWith('.' + host);
  } else {
    const p = new URL(property);
    within = u.origin === p.origin && u.pathname.startsWith(p.pathname);
  }
  if (!within) fail('COLLECTION_SCOPE', 'Concrete URL does not belong to the exact GSC property.');
}
export function validateTypedResourceScope(
  resources: string[],
  o: TypedObservation | CrawlObservation,
) {
  if (o.adapter === 'public_crawl') {
    if (crawlRequiredResources(o).some((url) => !resources.includes(url)))
      fail('COLLECTION_SCOPE', 'Crawl acquisition resources are outside the exact read scope.');
    return;
  }
  const required = [o.resource.propertyId, o.resource.url].filter((v): v is string => v !== null);
  if (o.adapter === 'gsc_search_analytics') {
    const pageIndex = o.request.dimensions?.indexOf('page') ?? -1;
    if (pageIndex >= 0)
      for (const row of o.report.rows ?? []) if (row.keys) required.push(row.keys[pageIndex]!);
    for (const group of o.request.dimensionFilterGroups ?? [])
      for (const filter of group.filters)
        if (filter.dimension === 'page' && (filter.operator ?? 'equals') === 'equals')
          required.push(filter.expression);
  }
  if (required.some((v) => !resources.includes(v)))
    fail('COLLECTION_SCOPE', 'Typed resources are outside the exact read scope.');
}
export function observationIdentity(
  o: Pick<TypedObservation, 'adapter' | 'sourceType' | 'resource' | 'request' | 'observedAt'>,
) {
  return hash({
    adapter: o.adapter,
    sourceType: o.sourceType,
    resource: o.resource,
    request: o.request,
    observedAt: o.observedAt,
  });
}
export function validateTypedEvidence(evidence: Evidence[]) {
  validateCrawlEvidence(evidence);
  const seen = new Map<string, TypedObservation>();
  for (const e of evidence) {
    const o = e.observation;
    if (!o || o.adapter === 'public_crawl') continue;
    const bindingMatches =
      o.adapter === 'dom'
        ? o.resource.propertyId === null &&
          o.resource.url === o.request.url &&
          o.request.capture.method ===
            (o.sourceType === 'source_html' ? 'source_export' : 'rendered_dom_export')
        : o.resource.propertyId === o.request.siteUrl &&
          o.resource.url === (o.adapter === 'gsc_url_inspection' ? o.request.inspectionUrl : null);
    const age = Date.parse(o.freshness.assessedAt) - Date.parse(o.observedAt);
    if (
      !bindingMatches ||
      age < 0 ||
      o.freshness.state !== (age > o.freshness.maxAgeHours * 3600000 ? 'stale' : 'current')
    )
      fail(
        'CONFLICTING_PROVENANCE',
        'Typed request/resource, capture or freshness binding is inconsistent.',
      );
    if (o.adapter === 'gsc_url_inspection')
      validateGscPropertyUrl(o.request.siteUrl, o.request.inspectionUrl);
    if (o.adapter === 'gsc_search_analytics') {
      const pageIndex = o.request.dimensions?.indexOf('page') ?? -1;
      if (pageIndex >= 0)
        for (const row of o.report.rows ?? [])
          if (row.keys) validateGscPropertyUrl(o.request.siteUrl, row.keys[pageIndex]!);
      for (const group of o.request.dimensionFilterGroups ?? [])
        for (const filter of group.filters)
          if (filter.dimension === 'page' && (filter.operator ?? 'equals') === 'equals')
            validateGscPropertyUrl(o.request.siteUrl, filter.expression);
    }
    const source = o.resource.propertyId ?? o.resource.url;
    const kind =
      o.adapter === 'dom'
        ? o.sourceType === 'source_html'
          ? 'source_html'
          : 'rendered_html'
        : o.adapter === 'gsc_url_inspection'
          ? 'gsc'
          : 'provider_metric';
    if (
      e.source !== source ||
      e.kind !== kind ||
      e.observedAt !== o.observedAt ||
      e.excerpt !== JSON.stringify(o) ||
      o.identitySha256 !== observationIdentity(o) ||
      !e.provenance ||
      e.provenance.collector !== o.callerAssertions.collector ||
      e.provenance.scope !== source ||
      e.provenance.permission !== 'read' ||
      e.provenance.sourceReported !== (o.basis === 'provider_reported') ||
      hash(e.provenance.limitations) !== hash(o.limitations)
    )
      fail(
        'CONFLICTING_PROVENANCE',
        'Typed evidence envelope and normalized observation must agree.',
      );
    const prior = seen.get(o.identitySha256);
    if (prior) {
      if (hash(prior.callerAssertions) !== hash(o.callerAssertions))
        fail('CONFLICTING_PROVENANCE', 'One observation identity has conflicting provenance.');
      if (prior.payloadSha256 !== o.payloadSha256)
        fail('CONFLICTING_OBSERVATION', 'One observation identity has conflicting payloads.');
      fail(
        'DUPLICATE_OBSERVATION',
        'Observation identities must be unique, including across imports.',
      );
    }
    seen.set(o.identitySha256, o);
  }
}
