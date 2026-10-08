import { z } from 'zod';
import { DocumentUrl } from './evidence-schema.ts';
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
const Reason = z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/);
const Rule = z
  .object({
    directive: z.enum(['allow', 'disallow']),
    path: z.string().max(512),
    line: z.number().int().positive(),
  })
  .strict();
const SourceFacts = z
  .object({
    canonicals: z.array(z.string().max(2000)).max(100),
    robots: z.array(z.string().max(2000)).max(100),
    titles: z.array(z.string().max(2000)).max(100),
    h1s: z.array(z.string().max(2000)).max(100),
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
      .max(100),
  })
  .strict();
export const CrawlReportSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('request'),
      purpose: z.enum(['robots', 'page']),
      requestedAt: z.iso.datetime(),
      cacheControl: z.string().max(500).nullable(),
      age: z.string().max(500).nullable(),
      date: z.string().max(500).nullable(),
      expires: z.string().max(500).nullable(),
      httpStatus: z.number().int().min(0).max(599).nullable(),
      contentType: z.string().max(500).nullable(),
      bodyBytes: z.number().int().nonnegative().nullable(),
      bodySha256: Digest.nullable(),
      completeness: z.enum(['complete', 'partial', 'UNKNOWN']),
      decision: z.enum(['observed', 'HOLD']),
      reason: Reason,
    })
    .strict(),
  z
    .object({
      type: z.literal('page'),
      requestIdentity: Digest.nullable(),
      bodySha256: Digest.nullable(),
      httpStatus: z.number().int().min(0).max(599).nullable(),
      contentType: z.string().max(500).nullable(),
      decision: z.enum(['observed', 'skip', 'HOLD']),
      reason: Reason,
      completeness: z.enum(['complete', 'partial', 'not_requested', 'UNKNOWN']),
      sourceFacts: SourceFacts.nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal('robots_decision'),
      targetUrl: DocumentUrl,
      robotsUrl: DocumentUrl,
      fetchedUrl: DocumentUrl.nullable(),
      requestIdentity: Digest.nullable(),
      bodySha256: Digest.nullable(),
      httpStatus: z.number().int().min(0).max(599).nullable(),
      decision: z.enum(['allow', 'disallow', 'HOLD']),
      reason: Reason,
      completeness: z.enum(['complete', 'not_requested', 'UNKNOWN']),
      cache: z.enum(['fresh', 'reused', 'stale', 'none']),
      expiresAt: z.iso.datetime().nullable(),
      matchedRule: Rule.nullable(),
      diagnostics: z
        .array(z.object({ line: z.number().int().nonnegative(), reason: Reason }).strict())
        .max(20),
      diagnosticsTruncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.enum(['link', 'redirect', 'sitemap']),
      requestIdentity: Digest,
      bodySha256: Digest,
      reference: z.string().max(2000),
      referenceTruncated: z.boolean(),
      httpStatus: z.number().int().min(0).max(599),
      targetUrl: DocumentUrl.nullable(),
      internal: z.boolean().nullable(),
      decision: z.enum(['queued', 'follow', 'skip', 'HOLD']),
      reason: Reason,
      completeness: z.enum(['complete', 'partial']),
    })
    .strict(),
]);
export const CrawlObservationSchema = z
  .object({
    version: z.literal(1),
    adapter: z.literal('public_crawl'),
    sourceType: z.literal('source_http'),
    basis: z.literal('observed_transport_and_local_decision'),
    identitySha256: Digest,
    payloadSha256: Digest,
    observedAt: z.iso.datetime(),
    resource: z.object({ propertyId: z.null(), url: DocumentUrl }).strict(),
    callerAssertions: z
      .object({
        collector: Id,
        permission: z.literal('read'),
        permissionReceipt: z.string().min(1).max(2000),
        exportId: Id,
      })
      .strict(),
    capture: z
      .object({
        crawlId: Id,
        sequence: z.number().int().min(1).max(100),
        scopeSha256: Digest,
        depth: z.number().int().min(0).max(10),
        parentIdentity: Digest.nullable(),
      })
      .strict(),
    report: CrawlReportSchema,
    limitations: z.array(z.string().min(1).max(2000)).max(20),
  })
  .strict();
export type CrawlObservation = z.infer<typeof CrawlObservationSchema>;
export type CrawlReport = z.infer<typeof CrawlReportSchema>;
