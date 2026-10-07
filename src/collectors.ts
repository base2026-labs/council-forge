import { z } from 'zod';
import { EvidenceSchema, Identifier, type Evidence } from './schema.ts';
import { fail } from './policy.ts';
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
  const observations = z.array(EvidenceSchema).max(scope.maxObservations).parse(rawObservations);
  if (Buffer.byteLength(JSON.stringify(observations), 'utf8') > scope.maxBytes)
    fail('COLLECTION_LIMIT', 'Observation packet exceeds the authorized byte bound.');
  if (new Set(observations.map((e) => e.id)).size !== observations.length)
    fail('DUPLICATE_EVIDENCE', 'Observation IDs must be unique.');
  return observations.map((e) => {
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
// This is permission-scoped ingestion, not a network collector. Caller-provided provenance
// remains a reported assertion; it is never elevated to observed indexation or causality.
export const collectorContracts = () => ({
  transport: 'supplied_observations',
  networkAccess: false,
  mutationAccess: false,
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
