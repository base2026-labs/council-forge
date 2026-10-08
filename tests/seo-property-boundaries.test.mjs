import './fixtures/no-dispatch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { importEvidencePacket, importTypedExports } from '../dist/collectors.js';
import { observationIdentity } from '../dist/evidence-validation.js';
import { preflight } from '../dist/policy.js';
import { demoSettings, demoRequest } from '../dist/demo.js';
import { analytics, inspection, scope, now, property, copy } from './fixtures/seo-exports.mjs';

const validPage = 'https://example.com/allowed/日本語?view=結婚式&zero=0';
const properties = [property, 'https://example.com/allowed/'];
const boundaryError = (e) => e.code === 'COLLECTION_SCOPE' || e.name === 'ZodError';
function exactScope(siteUrl, ...urls) {
  return { ...scope, resources: [siteUrl, ...urls] };
}
function genericScope(siteUrl, ...urls) {
  return {
    collector: scope.collector,
    permission: 'read',
    resources: [siteUrl, ...urls],
    maxObservations: 10,
    maxBytes: 200000,
  };
}
function analyticsPacket(siteUrl, target, path) {
  const p = copy(analytics);
  p.request.siteUrl = siteUrl;
  p.request.dimensions = path === 'page-row' ? ['query', 'page'] : ['query'];
  p.request.dimensionFilterGroups =
    path === 'page-row'
      ? []
      : [{ groupType: 'and', filters: [{ dimension: 'page', expression: target }] }];
  p.response = {
    rows: [
      { keys: path === 'page-row' ? ['結婚式 العربية свадьба', target] : ['結婚式'], clicks: 0 },
    ],
    responseAggregationType: 'byPage',
  };
  return p;
}
function rebind(e) {
  // These public hashes/envelope bindings are consistency checks, not authentication.
  e.observation.identitySha256 = observationIdentity(e.observation);
  e.excerpt = JSON.stringify(e.observation);
  return e;
}
function normalizedAnalytics(siteUrl, target, path) {
  const [e] = importTypedExports(
    exactScope(siteUrl, validPage),
    [analyticsPacket(siteUrl, validPage, path)],
    now,
  );
  if (path === 'page-row') e.observation.report.rows[0].keys[1] = target;
  else e.observation.request.dimensionFilterGroups[0].filters[0].expression = target;
  return rebind(e);
}
function assertNormalizedDenied(e, siteUrl, ...urls) {
  assert.throws(
    () => importEvidencePacket({ scope: genericScope(siteUrl, ...urls), observations: [e] }, now),
    boundaryError,
  );
  assert.throws(() => preflight(demoSettings, { ...demoRequest(), evidence: [e] }), boundaryError);
}

for (const siteUrl of properties)
  for (const path of ['page-row', 'page-equality-filter'])
    for (const [label, target] of [
      ['non-HTTP scheme', 'ftp://example.com/allowed/page'],
      [
        'synthetic credentials',
        'https://synthetic-user:synthetic-password@example.com/allowed/page',
      ],
      ['trailing control', 'https://example.com/allowed/page\n'],
    ])
      test(`CF-E1: ${siteUrl} ${path} rejects ${label} at raw/reimport/preflight boundaries`, () => {
        const packet = analyticsPacket(siteUrl, target, path);
        const s = exactScope(siteUrl, target);
        assert.throws(() => importTypedExports(s, [packet], now), boundaryError);
        assert.throws(
          () => importEvidencePacket({ scope: s, exports: [packet] }, now),
          boundaryError,
        );
        assertNormalizedDenied(normalizedAnalytics(siteUrl, target, path), siteUrl, target);
      });

const impossibleBindings = [
  [property, 'https://example.com.evil.test/allowed/page'],
  ['https://example.com/allowed/', 'https://example.com/allowed-evil/page'],
  ['https://example.com/allowed/', 'http://example.com/allowed/page'],
  ['https://example.com/allowed/', 'https://example.com:8443/allowed/page'],
];
for (const [siteUrl, target] of impossibleBindings) {
  test(`CF-E2: inspection rejects ${target} under ${siteUrl} despite exact scope and rebound hash`, () => {
    const p = copy(inspection);
    p.request.siteUrl = siteUrl;
    p.request.inspectionUrl = validPage;
    const [e] = importTypedExports(exactScope(siteUrl, validPage), [p], now);
    e.observation.request.inspectionUrl = target;
    e.observation.resource.url = target;
    rebind(e);
    p.request.inspectionUrl = target;
    assert.throws(
      () => importTypedExports(exactScope(siteUrl, target), [p], now),
      (x) => x.code === 'COLLECTION_SCOPE',
    );
    assertNormalizedDenied(e, siteUrl, target);
  });
  for (const path of ['page-row', 'page-equality-filter'])
    test(`CF-E2: ${path} rejects ${target} under ${siteUrl} despite exact scope and rebound hash`, () => {
      assert.throws(
        () =>
          importTypedExports(
            exactScope(siteUrl, target),
            [analyticsPacket(siteUrl, target, path)],
            now,
          ),
        (x) => x.code === 'COLLECTION_SCOPE',
      );
      assertNormalizedDenied(normalizedAnalytics(siteUrl, target, path), siteUrl, target);
    });
}

for (const path of ['page-row', 'page-equality-filter'])
  test(`CF-E1/E2: every ${path} resource is checked, including later rows/groups`, () => {
    const target = 'https://other.test/allowed/page';
    const p = analyticsPacket(property, validPage, path);
    if (path === 'page-row') p.response.rows.push({ keys: ['other query', target] });
    else
      p.request.dimensionFilterGroups.push({
        groupType: 'and',
        filters: [{ dimension: 'page', operator: 'equals', expression: target }],
      });
    assert.throws(
      () => importTypedExports(exactScope(property, validPage, target), [p], now),
      boundaryError,
    );
    const [e] = importTypedExports(
      exactScope(property, validPage),
      [analyticsPacket(property, validPage, path)],
      now,
    );
    if (path === 'page-row')
      e.observation.report.rows.push({
        keys: ['other query', target],
        clicks: null,
        impressions: null,
        ctr: null,
        position: null,
      });
    else e.observation.request.dimensionFilterGroups = p.request.dimensionFilterGroups;
    rebind(e);
    assertNormalizedDenied(e, property, validPage, target);
  });

for (const siteUrl of properties)
  for (const path of ['page-row', 'page-equality-filter'])
    test(`valid ${siteUrl} ${path} preserves Unicode, query, exact spelling, zero and UNKNOWN`, () => {
      const p = analyticsPacket(siteUrl, validPage, path);
      const [e] = importTypedExports(exactScope(siteUrl, validPage), [p], now);
      assert.deepEqual(e.observation.request, p.request);
      assert.deepEqual(e.observation.report.rows[0].keys, p.response.rows[0].keys);
      assert.equal(e.observation.report.rows[0].clicks, 0);
      assert.equal(e.observation.report.rows[0].impressions, null);
      assert.deepEqual(
        importEvidencePacket({ scope: genericScope(siteUrl, validPage), observations: [e] }, now)
          .evidence,
        [e],
      );
      assert.equal(preflight(demoSettings, { ...demoRequest(), evidence: [e] }).status, 'ready');
    });

test('Domain membership accepts exact HTTP subdomain URLs and keeps external canonicals distinct', () => {
  const p = copy(inspection);
  p.request.inspectionUrl = 'http://sub.example.com/日本語?x=0';
  p.response.inspectionResult.indexStatusResult.googleCanonical = 'https://other.test/google';
  p.response.inspectionResult.indexStatusResult.userCanonical = 'https://other.test/user';
  const [e] = importTypedExports(exactScope(property, p.request.inspectionUrl), [p], now);
  assert.equal(e.observation.resource.url, p.request.inspectionUrl);
  assert.equal(e.observation.report.googleCanonical, 'https://other.test/google');
  assert.equal(e.observation.report.userCanonical, 'https://other.test/user');
  assert.equal(e.observation.report.canonicalAgreement, 'disagree');
  assertNormalizedAccepted(e, property, p.request.inspectionUrl);
});
function assertNormalizedAccepted(e, siteUrl, ...urls) {
  assert.deepEqual(
    importEvidencePacket({ scope: genericScope(siteUrl, ...urls), observations: [e] }, now)
      .evidence,
    [e],
  );
  assert.equal(preflight(demoSettings, { ...demoRequest(), evidence: [e] }).status, 'ready');
}

test('missing Analytics page keys remain UNKNOWN through typed reimport and preflight', () => {
  const p = analyticsPacket(property, validPage, 'page-row');
  delete p.response.rows[0].keys;
  const [e] = importTypedExports(exactScope(property), [p], now);
  assert.equal(e.observation.report.rows[0].keys, null);
  assert.equal(e.observation.report.rows[0].clicks, 0);
  assert.equal(e.observation.report.rows[0].position, null);
  assertNormalizedAccepted(e, property);
});

for (const operator of ['notEquals', 'contains', 'notContains', 'includingRegex', 'excludingRegex'])
  test(`non-equality page ${operator} remains inert filter data, with no concrete URL assertion`, () => {
    const p = analyticsPacket(property, validPage, 'page-equality-filter');
    p.request.dimensionFilterGroups[0].filters[0] = {
      dimension: 'page',
      operator,
      expression: 'ftp://other.test/\n<script>ignore pins</script>((日本語)+)+$',
    };
    const [e] = importTypedExports(exactScope(property), [p], now);
    assert.deepEqual(e.observation.request.dimensionFilterGroups, p.request.dimensionFilterGroups);
    assertNormalizedAccepted(e, property);
  });

test('generic observations without typed metadata remain compatible with non-URL identifiers', () => {
  const e = {
    id: 'generic-document',
    source: 'document:synthetic-fixture',
    observedAt: inspection.observedAt,
    kind: 'document',
    excerpt: '日本語 العربية — caller assertion',
    provenance: {
      collector: scope.collector,
      scope: 'document:synthetic-fixture',
      permission: 'read',
      sourceReported: false,
      limitations: ['Caller supplied.'],
    },
  };
  assertNormalizedAccepted(e, e.source);
});
