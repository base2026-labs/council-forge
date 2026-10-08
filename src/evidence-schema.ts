import { z } from 'zod';

const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const Text = z.string().min(1).max(2000);
export const DocumentUrl = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => {
    try {
      const u = new URL(value);
      return (
        /^https?:\/\//.test(value) &&
        !/[\u0000-\u0020\u007f]/.test(value) &&
        ['https:', 'http:'].includes(u.protocol) &&
        !u.username &&
        !u.password
      );
    } catch {
      return false;
    }
  }, 'Use an HTTP(S) resource identifier without credentials.');
export const PropertyId = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => {
    if (value.startsWith('sc-domain:')) {
      const domain = value.slice(10);
      return (
        /^[a-zA-Z0-9.-]+$/.test(domain) &&
        !domain.startsWith('.') &&
        !domain.endsWith('.') &&
        domain
          .split('.')
          .every(
            (label) =>
              label.length > 0 &&
              label.length <= 63 &&
              !label.startsWith('-') &&
              !label.endsWith('-'),
          )
      );
    }
    return (
      DocumentUrl.safeParse(value).success &&
      value.endsWith('/') &&
      !new URL(value).search &&
      !new URL(value).hash
    );
  }, 'Use the exact GSC Domain or URL-prefix property ID.');
const DateOnly = z.iso.date();
const Dimension = z.enum([
  'date',
  'hour',
  'query',
  'page',
  'country',
  'device',
  'searchAppearance',
]);
const FilterDimension = z.enum(['query', 'page', 'country', 'device', 'searchAppearance']);
export const InspectionRequest = z
  .object({
    siteUrl: PropertyId,
    inspectionUrl: DocumentUrl,
    languageCode: z.string().min(2).max(35).optional(),
  })
  .strict();
export const AnalyticsRequest = z
  .object({
    siteUrl: PropertyId,
    startDate: DateOnly,
    endDate: DateOnly,
    dimensions: z.array(Dimension).max(7).optional(),
    dimensionFilterGroups: z
      .array(
        z
          .object({
            groupType: z.literal('and'),
            filters: z
              .array(
                z
                  .object({
                    dimension: FilterDimension,
                    operator: z
                      .enum([
                        'equals',
                        'notEquals',
                        'contains',
                        'notContains',
                        'includingRegex',
                        'excludingRegex',
                      ])
                      .optional(),
                    expression: z.string().max(4096),
                  })
                  .strict(),
              )
              .max(20),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    type: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional(),
    searchType: z.enum(['web', 'image', 'video', 'news', 'discover', 'googleNews']).optional(),
    aggregationType: z.enum(['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel']).optional(),
    dataState: z
      .string()
      .refine((v) => ['all', 'final', 'hourly_all'].includes(v.toLowerCase()))
      .optional(),
    rowLimit: z.number().int().min(1).max(25000).optional(),
    startRow: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const days = (Date.parse(v.endDate) - Date.parse(v.startDate)) / 86400000 + 1;
    if (days < 1 || days > 366)
      ctx.addIssue({
        code: 'custom',
        message: 'Date windows are bounded to 1–366 inclusive PT dates.',
      });
    if (new Set(v.dimensions).size !== (v.dimensions?.length ?? 0))
      ctx.addIssue({ code: 'custom', message: 'Dimension names must be unique.' });
    if (v.type && v.searchType)
      ctx.addIssue({ code: 'custom', message: 'Supply type or deprecated searchType, not both.' });
    if (
      v.aggregationType === 'byProperty' &&
      (v.dimensions?.includes('page') ||
        v.dimensionFilterGroups?.some((g) => g.filters.some((f) => f.dimension === 'page')))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'GSC does not support property aggregation with a page dimension/filter.',
      });
  });
const Verdict = z.enum(['VERDICT_UNSPECIFIED', 'PASS', 'PARTIAL', 'FAIL', 'NEUTRAL']);
const IndexReport = z
  .object({
    verdict: Verdict.optional(),
    coverageState: Text.optional(),
    robotsTxtState: z.enum(['ROBOTS_TXT_STATE_UNSPECIFIED', 'ALLOWED', 'DISALLOWED']).optional(),
    indexingState: z
      .enum([
        'INDEXING_STATE_UNSPECIFIED',
        'INDEXING_ALLOWED',
        'BLOCKED_BY_META_TAG',
        'BLOCKED_BY_HTTP_HEADER',
        'BLOCKED_BY_ROBOTS_TXT',
      ])
      .optional(),
    lastCrawlTime: z.iso.datetime().optional(),
    pageFetchState: z
      .enum([
        'PAGE_FETCH_STATE_UNSPECIFIED',
        'SUCCESSFUL',
        'SOFT_404',
        'BLOCKED_ROBOTS_TXT',
        'NOT_FOUND',
        'ACCESS_DENIED',
        'SERVER_ERROR',
        'REDIRECT_ERROR',
        'ACCESS_FORBIDDEN',
        'BLOCKED_4XX',
        'INTERNAL_CRAWL_ERROR',
        'INVALID_URL',
      ])
      .optional(),
    googleCanonical: DocumentUrl.optional(),
    userCanonical: DocumentUrl.optional(),
    crawledAs: z.enum(['CRAWLING_USER_AGENT_UNSPECIFIED', 'DESKTOP', 'MOBILE']).optional(),
    sitemap: z.array(DocumentUrl).max(100).optional(),
    referringUrls: z.array(DocumentUrl).max(100).optional(),
  })
  .passthrough();
const ProviderError = z
  .object({
    code: z.number().int().min(100).max(599).optional(),
    message: Text.optional(),
    status: Text.optional(),
  })
  .passthrough();
export const InspectionResponse = z
  .object({
    inspectionResult: z
      .object({
        inspectionResultLink: DocumentUrl.optional(),
        indexStatusResult: IndexReport.optional(),
      })
      .passthrough()
      .optional(),
    error: ProviderError.optional(),
  })
  .passthrough();
const Metric = z.number().finite().nonnegative();
const AnalyticsRow = z
  .object({
    keys: z.array(z.string().max(4096)).max(7).optional(),
    clicks: Metric.optional(),
    impressions: Metric.optional(),
    ctr: Metric.max(1).optional(),
    position: Metric.optional(),
  })
  .passthrough();
export const AnalyticsResponse = z
  .object({
    rows: z.array(AnalyticsRow).max(100).optional(),
    responseAggregationType: z
      .enum(['auto', 'byPage', 'byProperty', 'byNewsShowcasePanel'])
      .optional(),
    metadata: z
      .object({
        first_incomplete_date: DateOnly.optional(),
        first_incomplete_hour: z.iso.datetime({ offset: true }).optional(),
      })
      .passthrough()
      .optional(),
    error: ProviderError.optional(),
  })
  .passthrough();
const CallerProvenance = z
  .object({
    collector: Id,
    permission: z.literal('read'),
    permissionReceipt: z.string().min(1).max(500),
    exportId: Id,
  })
  .strict();
const SuppliedCompleteness = z
  .object({ state: z.enum(['complete', 'partial', 'unknown']), truncated: z.boolean().nullable() })
  .strict();
const ExportHeader = {
  id: Id,
  observedAt: z.iso.datetime(),
  provenance: CallerProvenance,
  completeness: SuppliedCompleteness,
};
export const SourceCapture = z
  .object({ method: z.literal('source_export'), description: Text })
  .strict();
export const RenderedCapture = z
  .object({ method: z.literal('rendered_dom_export'), description: Text, renderer: Text })
  .strict();
export const TypedExportSchema = z.discriminatedUnion('sourceType', [
  z
    .object({
      ...ExportHeader,
      sourceType: z.literal('gsc_url_inspection_export'),
      request: InspectionRequest,
      response: InspectionResponse,
    })
    .strict(),
  z
    .object({
      ...ExportHeader,
      sourceType: z.literal('gsc_search_analytics_export'),
      request: AnalyticsRequest,
      response: AnalyticsResponse,
    })
    .strict(),
  z
    .object({
      ...ExportHeader,
      sourceType: z.literal('source_html'),
      url: DocumentUrl,
      capture: SourceCapture,
      html: z.string().max(200000),
    })
    .strict(),
  z
    .object({
      ...ExportHeader,
      sourceType: z.literal('rendered_dom'),
      url: DocumentUrl,
      capture: RenderedCapture,
      html: z.string().max(200000),
    })
    .strict(),
]);
export type TypedExport = z.infer<typeof TypedExportSchema>;
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const NullText = Text.nullable();
const CommonObservation = {
  version: z.literal(1),
  identitySha256: Digest,
  payloadSha256: Digest,
  observedAt: z.iso.datetime(),
  callerAssertions: CallerProvenance,
  resource: z.object({ propertyId: PropertyId.nullable(), url: DocumentUrl.nullable() }).strict(),
  freshness: z
    .object({
      assessedAt: z.iso.datetime(),
      maxAgeHours: z.number().positive().max(8760),
      state: z.enum(['current', 'stale']),
    })
    .strict(),
  completeness: z
    .object({ caller: SuppliedCompleteness, providerCoverage: z.literal('UNKNOWN') })
    .strict(),
  status: z.enum(['ok', 'partial', 'error', 'UNKNOWN']),
  error: z
    .object({ code: z.number().int().nullable(), status: NullText, message: NullText })
    .strict()
    .nullable(),
  unmappedFields: z.array(z.string().max(500)).max(100),
  limitations: z.array(Text).max(20),
};
const NormalizedIndexReport = z
  .object({
    verdict: Verdict.nullable(),
    coverageState: NullText,
    robotsTxtState: IndexReport.shape.robotsTxtState.unwrap().nullable(),
    indexingState: IndexReport.shape.indexingState.unwrap().nullable(),
    lastCrawlTime: z.iso.datetime().nullable(),
    pageFetchState: IndexReport.shape.pageFetchState.unwrap().nullable(),
    googleCanonical: DocumentUrl.nullable(),
    userCanonical: DocumentUrl.nullable(),
    crawledAs: IndexReport.shape.crawledAs.unwrap().nullable(),
    sitemap: z.array(DocumentUrl).max(100).nullable(),
    referringUrls: z.array(DocumentUrl).max(100).nullable(),
    inspectionResultLink: DocumentUrl.nullable(),
    canonicalAgreement: z.enum(['agree', 'disagree', 'UNKNOWN']),
  })
  .strict();
const NormalizedAnalytics = z
  .object({
    rows: z
      .array(
        z
          .object({
            keys: z.array(z.string().max(4096)).max(7).nullable(),
            clicks: Metric.nullable(),
            impressions: Metric.nullable(),
            ctr: Metric.max(1).nullable(),
            position: Metric.nullable(),
          })
          .strict(),
      )
      .max(100)
      .nullable(),
    responseAggregationType: AnalyticsResponse.shape.responseAggregationType.unwrap().nullable(),
    metadata: z
      .object({
        first_incomplete_date: DateOnly.nullable(),
        first_incomplete_hour: z.iso.datetime({ offset: true }).nullable(),
      })
      .strict(),
    dateCoverage: z
      .object({
        datesWithRows: z.array(DateOnly).max(100),
        missingDates: z.array(DateOnly).max(366).nullable(),
        missingDateMeaning: z.literal('UNKNOWN'),
      })
      .strict(),
    truncationSignals: z
      .array(
        z.enum([
          'caller_partial',
          'caller_truncated',
          'row_limit_reached',
          'offset_page',
          'provider_top_rows_only',
        ]),
      )
      .max(5),
    dateWindowTimeZone: z.literal('America/Los_Angeles'),
  })
  .strict();
const NullableFacts = z.array(z.string().max(2000)).max(100).nullable();
export const DomReport = z
  .object({
    canonicalDeclarations: NullableFacts,
    robotsMeta: NullableFacts,
    titles: NullableFacts,
    h1s: NullableFacts,
    images: z
      .object({
        total: z.number().int().nonnegative(),
        missingAlt: z.number().int().nonnegative(),
        emptyAlt: z.number().int().nonnegative(),
      })
      .strict(),
    jsonLd: z
      .array(
        z
          .object({ validJson: z.boolean(), types: z.array(z.string().max(2000)).max(100) })
          .strict(),
      )
      .max(100)
      .nullable(),
    richResultEligibility: z.literal('UNKNOWN'),
    indexation: z.literal('UNKNOWN'),
    rankingCausality: z.literal('UNKNOWN'),
  })
  .strict();
export const TypedObservationSchema = z.discriminatedUnion('adapter', [
  z
    .object({
      ...CommonObservation,
      adapter: z.literal('gsc_url_inspection'),
      sourceType: z.literal('gsc_url_inspection_export'),
      basis: z.literal('provider_reported'),
      request: InspectionRequest,
      report: NormalizedIndexReport,
    })
    .strict(),
  z
    .object({
      ...CommonObservation,
      adapter: z.literal('gsc_search_analytics'),
      sourceType: z.literal('gsc_search_analytics_export'),
      basis: z.literal('provider_reported'),
      request: AnalyticsRequest,
      report: NormalizedAnalytics,
    })
    .strict(),
  z
    .object({
      ...CommonObservation,
      adapter: z.literal('dom'),
      sourceType: z.enum(['source_html', 'rendered_dom']),
      basis: z.literal('observed_supplied_document'),
      request: z
        .object({ url: DocumentUrl, capture: z.union([SourceCapture, RenderedCapture]) })
        .strict(),
      report: DomReport,
    })
    .strict(),
]);
export type TypedObservation = z.infer<typeof TypedObservationSchema>;
