import { z } from 'zod';
import { EvidenceSchema, Identifier, type Evidence } from './schema.ts';
import { fail, hash } from './policy.ts';
import { createHash } from 'node:crypto';
import {
  TypedExportSchema,
  TypedObservationSchema,
  type TypedExport,
  type TypedObservation,
} from './evidence-schema.ts';
import {
  boundJson,
  observationIdentity,
  validateTypedEvidence,
  validateTypedResourceScope,
} from './evidence-validation.ts';
import { inspectDom } from './seo.ts';
export { TypedExportSchema } from './evidence-schema.ts';
export const ObservationScope = z
  .object({
    collector: Identifier,
    permission: z.literal('read'),
    resources: z.array(z.string().min(1).max(500)).min(1).max(100),
    maxObservations: z.number().int().min(1).max(100),
    maxBytes: z.number().int().min(1).max(200000),
  })
  .strict();
export function importObservations(rawScope: unknown, rawObservations: unknown): Evidence[] {
  const scope = ObservationScope.parse(rawScope);
  boundJson(rawObservations, scope.maxBytes, 32);
  const observations = z.array(EvidenceSchema).max(scope.maxObservations).parse(rawObservations);
  if (Buffer.byteLength(JSON.stringify(observations), 'utf8') > scope.maxBytes)
    fail('COLLECTION_LIMIT', 'Observation packet exceeds the authorized byte bound.');
  if (new Set(observations.map((e) => e.id)).size !== observations.length)
    fail('DUPLICATE_EVIDENCE', 'Observation IDs must be unique.');
  validateTypedEvidence(observations);
  return observations.map((e) => {
    if (e.observation) validateTypedResourceScope(scope.resources, e.observation);
    if (!scope.resources.includes(e.source))
      fail('COLLECTION_SCOPE', 'Observation source is outside the exact authorized resource set.');
    if (Date.parse(e.observedAt) > Date.now() + 300000)
      fail('FUTURE_EVIDENCE', 'Observation date is in the future.');
    if (
      !e.provenance ||
      e.provenance.collector !== scope.collector ||
      e.provenance.scope !== e.source ||
      e.provenance.permission !== 'read'
    )
      fail(
        'PROVENANCE_REQUIRED',
        'Imported evidence needs a matching collector, exact resource and read permission receipt.',
      );
    return e;
  });
}

export const TypedObservationScope = ObservationScope.extend({
  maxDepth: z.number().int().min(8).max(32).default(20),
  maxRows: z.number().int().min(1).max(100).default(100),
  maxDomNodes: z.number().int().min(1).max(20000).default(5000),
  maxFacts: z.number().int().min(1).max(100).default(100),
  maxAgeHours: z.number().positive().max(8760).default(168),
}).strict();
type TypedScope = z.infer<typeof TypedObservationScope>;
const commonLimitations = [
  'Supplied export only; no network, browser, SEO API or inference was dispatched.',
  'Request identity, source type, permission receipt, observation time and completeness are caller assertions, not independently authenticated.',
  'Missing fields and metrics are null (UNKNOWN); no observation establishes indexation or ranking causality.',
];
function scoped(scope: TypedScope, resource: string) {
  if (!scope.resources.includes(resource))
    fail('COLLECTION_SCOPE', 'Resource is outside the exact authorized set.');
}
function withinProperty(property: string, url: string) {
  const u = new URL(url);
  if (property.startsWith('sc-domain:')) {
    const host = property.slice(10).toLowerCase();
    return u.hostname === host || u.hostname.endsWith('.' + host);
  }
  const p = new URL(property);
  return u.origin === p.origin && u.pathname.startsWith(p.pathname);
}
const providerError = (e: { code?: number; status?: string; message?: string } | undefined) =>
  e ? { code: e.code ?? null, status: e.status ?? null, message: e.message ?? null } : null;
function extraFields(obj: object | undefined, known: readonly string[], prefix: string): string[] {
  return obj
    ? Object.keys(obj)
        .filter((k) => !known.includes(k))
        .map((k) => prefix + k)
    : [];
}
function normalize(scope: TypedScope, packet: TypedExport, nowMs: number): TypedObservation {
  if (packet.provenance.collector !== scope.collector)
    fail('PROVENANCE_REQUIRED', 'Export collector must match the read scope.');
  const observedMs = Date.parse(packet.observedAt);
  if (observedMs > nowMs) fail('FUTURE_EVIDENCE', 'Supplied observation time is in the future.');
  const stale = nowMs - observedMs > scope.maxAgeHours * 3600000;
  const common = {
    version: 1 as const,
    observedAt: packet.observedAt,
    callerAssertions: packet.provenance,
    freshness: {
      assessedAt: new Date(nowMs).toISOString(),
      maxAgeHours: scope.maxAgeHours,
      state: stale ? ('stale' as const) : ('current' as const),
    },
    completeness: { caller: packet.completeness, providerCoverage: 'UNKNOWN' as const },
    limitations: [
      ...commonLimitations,
      ...(stale
        ? [
            'This observation exceeds the declared freshness window; it does not establish current state.',
          ]
        : []),
    ],
  };
  if (packet.sourceType === 'source_html' || packet.sourceType === 'rendered_dom') {
    scoped(scope, packet.url);
    const facts = inspectDom(packet.html, packet.url, {
      maxDepth: scope.maxDepth,
      maxNodes: scope.maxDomNodes,
      maxFacts: scope.maxFacts,
    });
    const complete =
      packet.completeness.state === 'complete' && packet.completeness.truncated === false;
    const present = <T>(values: T[]) => (values.length || complete ? values : null);
    const body = {
      ...common,
      adapter: 'dom' as const,
      sourceType: packet.sourceType,
      basis: 'observed_supplied_document' as const,
      resource: { propertyId: null, url: packet.url },
      request: { url: packet.url, capture: packet.capture },
      payloadSha256: createHash('sha256').update(packet.html, 'utf8').digest('hex'),
      status: complete ? ('ok' as const) : ('partial' as const),
      error: null,
      unmappedFields: [],
      report: {
        canonicalDeclarations: present(facts.canonicals),
        robotsMeta: present(facts.robots),
        titles: present(facts.titles),
        h1s: present(facts.h1s),
        images: facts.images,
        jsonLd: present(facts.jsonLd),
        richResultEligibility: 'UNKNOWN' as const,
        indexation: 'UNKNOWN' as const,
        rankingCausality: 'UNKNOWN' as const,
      },
      limitations: [
        ...common.limitations,
        packet.sourceType === 'source_html'
          ? 'Source HTML is not rendered DOM evidence; JavaScript was not executed.'
          : 'Rendered acquisition and renderer identity are caller-reported; this runtime only parses the supplied DOM serialization.',
        'Facts describe the supplied document only; partial/unknown completeness cannot establish absence on the whole page.',
        'Canonical declarations are raw attribute values, distinct from GSC user canonical and Google-selected canonical.',
        'JSON-LD JSON syntax/type labels do not establish schema validity or rich-result eligibility. HTTP headers, redirects, robots.txt and live indexation were not checked.',
      ],
    };
    return TypedObservationSchema.parse({ ...body, identitySha256: observationIdentity(body) });
  }
  scoped(scope, packet.request.siteUrl);
  const response = packet.response;
  const error = providerError(response.error);
  const resource = {
    propertyId: packet.request.siteUrl,
    url: packet.sourceType === 'gsc_url_inspection_export' ? packet.request.inspectionUrl : null,
  };
  const base = {
    ...common,
    sourceType: packet.sourceType,
    basis: 'provider_reported' as const,
    resource,
    request: packet.request,
    payloadSha256: hash(response),
    error,
  };
  if (packet.sourceType === 'gsc_url_inspection_export') {
    scoped(scope, packet.request.inspectionUrl);
    if (!withinProperty(packet.request.siteUrl, packet.request.inspectionUrl))
      fail('COLLECTION_SCOPE', 'Inspected URL does not belong to the exact property.');
    const result = error ? undefined : packet.response.inspectionResult;
    const index = result?.indexStatusResult;
    if (index?.lastCrawlTime && Date.parse(index.lastCrawlTime) > observedMs)
      fail('TEMPORAL_CONFLICT', 'Reported crawl time is later than the supplied observation time.');
    const fields = [
      'verdict',
      'coverageState',
      'robotsTxtState',
      'indexingState',
      'lastCrawlTime',
      'pageFetchState',
      'googleCanonical',
      'userCanonical',
      'crawledAs',
      'sitemap',
      'referringUrls',
    ] as const;
    const report = {
      verdict: index?.verdict ?? null,
      coverageState: index?.coverageState ?? null,
      robotsTxtState: index?.robotsTxtState ?? null,
      indexingState: index?.indexingState ?? null,
      lastCrawlTime: index?.lastCrawlTime ?? null,
      pageFetchState: index?.pageFetchState ?? null,
      googleCanonical: index?.googleCanonical ?? null,
      userCanonical: index?.userCanonical ?? null,
      crawledAs: index?.crawledAs ?? null,
      sitemap: index?.sitemap ?? null,
      referringUrls: index?.referringUrls ?? null,
      inspectionResultLink: result?.inspectionResultLink ?? null,
      canonicalAgreement:
        index?.googleCanonical && index.userCanonical
          ? index.googleCanonical === index.userCanonical
            ? ('agree' as const)
            : ('disagree' as const)
          : ('UNKNOWN' as const),
    };
    const body = {
      ...base,
      adapter: 'gsc_url_inspection' as const,
      sourceType: packet.sourceType,
      request: packet.request,
      report,
      status: error
        ? 'error'
        : !index
          ? 'UNKNOWN'
          : fields.some((k) => index[k] === undefined) ||
              packet.completeness.state !== 'complete' ||
              packet.completeness.truncated !== false
            ? 'partial'
            : 'ok',
      unmappedFields: [
        ...extraFields(packet.response, ['inspectionResult', 'error'], 'response.'),
        ...extraFields(
          packet.response.inspectionResult,
          ['inspectionResultLink', 'indexStatusResult'],
          'inspectionResult.',
        ),
        ...extraFields(
          packet.response.inspectionResult?.indexStatusResult,
          fields,
          'indexStatusResult.',
        ),
      ],
      limitations: [
        ...common.limitations,
        'GSC reports the indexed version, not live URL indexability. Canonical disagreement is reported, not a diagnosis.',
        'Sitemaps/referring URLs are not exhaustive. Missing canonicals/states are UNKNOWN; an unspecified state is not a negative finding.',
        'AMP, mobile-usability and rich-results result mappings are held outside this adapter; unmapped fields are named and covered by the payload hash.',
      ],
    };
    return TypedObservationSchema.parse({ ...body, identitySha256: observationIdentity(body) });
  }
  const r = packet.request;
  const dimensions = r.dimensions ?? [];
  const rows = error ? undefined : packet.response.rows;
  if (rows && (rows.length > scope.maxRows || rows.length > (r.rowLimit ?? 1000)))
    fail('COLLECTION_LIMIT', 'Search Analytics rows exceed the requested or authorized count.');
  if (!dimensions.length && rows && rows.length > 1)
    fail('INVALID_EXPORT', 'Ungrouped Search Analytics has at most one aggregate row.');
  const knownKeys = new Set<string>();
  for (const row of rows ?? []) {
    if (row.keys && row.keys.length !== dimensions.length)
      fail('INVALID_EXPORT', 'Search Analytics keys must follow the supplied dimension order.');
    if (row.keys) {
      const key = JSON.stringify(row.keys);
      if (knownKeys.has(key))
        fail('DUPLICATE_OBSERVATION', 'Search Analytics dimension tuples must be unique.');
      knownKeys.add(key);
      const date = row.keys[dimensions.indexOf('date')];
      if (
        dimensions.includes('date') &&
        (!z.iso.date().safeParse(date).success || date! < r.startDate || date! > r.endDate)
      )
        fail('INVALID_EXPORT', 'Row date is invalid or outside the exact requested window.');
      const page = row.keys[dimensions.indexOf('page')];
      if (dimensions.includes('page')) {
        if (!page || !withinProperty(r.siteUrl, page))
          fail('COLLECTION_SCOPE', 'Row page does not belong to the exact property.');
        scoped(scope, page!);
      }
    }
  }
  // Regex filters are preserved as data, never executed. Explicit page equality is exact scope.
  for (const group of r.dimensionFilterGroups ?? [])
    for (const f of group.filters) {
      if (f.dimension === 'page' && (f.operator ?? 'equals') === 'equals') {
        if (!withinProperty(r.siteUrl, f.expression))
          fail('COLLECTION_SCOPE', 'Page filter does not belong to the exact property.');
        scoped(scope, f.expression);
      }
    }
  const dates = [
    ...new Set(
      (rows ?? []).flatMap((row) =>
        row.keys && dimensions.includes('date') ? [row.keys[dimensions.indexOf('date')]!] : [],
      ),
    ),
  ].sort();
  const missingDates: string[] | null = rows && dimensions.includes('date') ? [] : null;
  if (missingDates)
    for (let t = Date.parse(r.startDate); t <= Date.parse(r.endDate); t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (!dates.includes(d)) missingDates.push(d);
    }
  const signals = [
    'provider_top_rows_only',
    ...(packet.completeness.state === 'partial' ? ['caller_partial'] : []),
    ...(packet.completeness.truncated === true ? ['caller_truncated'] : []),
    ...(rows?.length === (r.rowLimit ?? 1000) ? ['row_limit_reached'] : []),
    ...((r.startRow ?? 0) > 0 ? ['offset_page'] : []),
  ];
  const metadata = error ? undefined : packet.response.metadata;
  if (
    metadata?.first_incomplete_date &&
    ((r.dataState ?? 'final').toLowerCase() !== 'all' ||
      !dimensions.includes('date') ||
      metadata.first_incomplete_date < r.startDate ||
      metadata.first_incomplete_date > r.endDate)
  )
    fail(
      'INVALID_EXPORT',
      'Incomplete-date metadata conflicts with the documented request contract.',
    );
  if (
    metadata?.first_incomplete_hour &&
    ((r.dataState ?? 'final').toLowerCase() !== 'hourly_all' || !dimensions.includes('hour'))
  )
    fail(
      'INVALID_EXPORT',
      'Incomplete-hour metadata requires an hourly_all request grouped by hour.',
    );
  const report = {
    rows:
      rows?.map((row) => ({
        keys: row.keys ?? (dimensions.length === 0 ? [] : null),
        clicks: row.clicks ?? null,
        impressions: row.impressions ?? null,
        ctr: row.ctr ?? null,
        position: row.position ?? null,
      })) ?? null,
    responseAggregationType: error ? null : (packet.response.responseAggregationType ?? null),
    metadata: {
      first_incomplete_date: metadata?.first_incomplete_date ?? null,
      first_incomplete_hour: metadata?.first_incomplete_hour ?? null,
    },
    dateCoverage: { datesWithRows: dates, missingDates, missingDateMeaning: 'UNKNOWN' },
    truncationSignals: signals,
    dateWindowTimeZone: 'America/Los_Angeles',
  };
  const body = {
    ...base,
    adapter: 'gsc_search_analytics' as const,
    sourceType: packet.sourceType,
    request: r,
    report,
    status: error ? 'error' : rows ? 'partial' : 'UNKNOWN',
    unmappedFields: [
      ...extraFields(
        packet.response,
        ['rows', 'responseAggregationType', 'metadata', 'error'],
        'response.',
      ),
      ...extraFields(
        packet.response.metadata,
        ['first_incomplete_date', 'first_incomplete_hour'],
        'metadata.',
      ),
      ...(rows ?? []).flatMap((row, i) =>
        extraFields(row, ['keys', 'clicks', 'impressions', 'ctr', 'position'], `rows[${i}].`),
      ),
    ],
    limitations: [
      ...common.limitations,
      'Search Analytics returns top rows and does not guarantee exhaustive coverage; this packet cannot establish complete property totals.',
      'Dates are inclusive America/Los_Angeles (PT) dates. Omitted dates/rows may have no data or be unavailable; never fill with zero.',
      'Clicks/impressions/CTR/average position are provider reports, not sampled SERP ranks or evidence of causality. No aggregation across query rows is inferred.',
      'Filters and defaults belong to the supplied request; regex expressions are inert and were not evaluated locally.',
    ],
  };
  return TypedObservationSchema.parse({ ...body, identitySha256: observationIdentity(body) });
}
export function importTypedExports(
  rawScope: unknown,
  rawExports: unknown,
  nowMs = Date.now(),
): Evidence[] {
  const scope = TypedObservationScope.parse(rawScope);
  if (Array.isArray(rawExports) && rawExports.length > scope.maxObservations)
    fail('COLLECTION_LIMIT', 'Export packet count exceeds the authorized bound.');
  boundJson(rawExports, scope.maxBytes, scope.maxDepth);
  const packets = z.array(TypedExportSchema).max(scope.maxObservations).parse(rawExports);
  const evidence = packets.map((packet) => {
    const observation = normalize(scope, packet, nowMs);
    const source = observation.resource.propertyId ?? observation.resource.url!;
    return EvidenceSchema.parse({
      id: packet.id,
      source,
      observedAt: packet.observedAt,
      kind:
        observation.adapter === 'dom'
          ? observation.sourceType === 'source_html'
            ? 'source_html'
            : 'rendered_html'
          : observation.adapter === 'gsc_url_inspection'
            ? 'gsc'
            : 'provider_metric',
      excerpt: JSON.stringify(observation),
      observation,
      provenance: {
        collector: scope.collector,
        scope: source,
        permission: 'read',
        sourceReported: observation.basis === 'provider_reported',
        limitations: observation.limitations,
      },
    });
  });
  if (new Set(evidence.map((e) => e.id)).size !== evidence.length)
    fail('DUPLICATE_EVIDENCE', 'Evidence IDs must be unique.');
  validateTypedEvidence(evidence);
  boundJson(evidence, scope.maxBytes, 32);
  return evidence;
}
export const EvidencePacketSchema = z
  .object({
    scope: z.union([ObservationScope, TypedObservationScope]),
    observations: z.array(EvidenceSchema).max(100).optional(),
    exports: z.array(TypedExportSchema).max(100).optional(),
  })
  .strict()
  .superRefine((packet, ctx) => {
    if ((packet.observations === undefined) === (packet.exports === undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'Supply exactly one observations or exports array.',
      });
  });
export function importEvidencePacket(raw: unknown, nowMs = Date.now()) {
  boundJson(raw, 200000, 40);
  const packet = EvidencePacketSchema.parse(raw);
  return {
    evidence:
      packet.exports !== undefined
        ? importTypedExports(packet.scope, packet.exports, nowMs)
        : importObservations(packet.scope, packet.observations),
    networkAccess: false,
    inferenceDispatched: false,
    permissionScope: 'read_only',
  };
}
// This is permission-scoped ingestion, not a network collector. Caller-provided provenance
// remains a reported assertion; it is never elevated to observed indexation or causality.
export const collectorContracts = () => ({
  transport: 'supplied_observations',
  networkAccess: false,
  mutationAccess: false,
  inferenceAccess: false,
  typedAdapters: [
    'gsc_url_inspection_export',
    'gsc_search_analytics_export',
    'source_html',
    'rendered_dom',
  ],
  unknownRepresentation: 'null fields and explicit UNKNOWN coverage/eligibility/causality',
  requires: [
    'exact resource scope',
    'read permission',
    'observation timestamp',
    'collector identity',
    'limitations',
    'byte and count bounds',
  ],
  limitations: [
    'No automatic GSC, browser, crawler or paid SERP connection.',
    'Provider-reported metrics and hypotheses remain separately typed.',
  ],
});
