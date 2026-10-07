import { SettingsSchema, RequestSchema } from './schema.ts';
export const demoSettings = SettingsSchema.parse({
  providers: [
    {
      id: 'demo',
      kind: 'mock',
      models: [
        {
          id: 'fixture-model',
          label: 'Offline fixture — not a live model',
          efforts: ['low', 'high'],
          responseIds: ['fixture-model'],
        },
      ],
    },
  ],
  allowedModes: ['subscription_only', 'api_only', 'hybrid'],
  liveEnabled: false,
});
export function demoRequest(runId = 'offline-demo') {
  return RequestSchema.parse({
    runId,
    task: 'Does the canonical tag prove why Google has not indexed this page?',
    kind: 'seo_audit',
    mode: 'subscription_only',
    agents: [
      { id: 'seo', role: 'technical_seo', providerId: 'demo', model: 'fixture-model' },
      { id: 'skeptic', role: 'skeptic', providerId: 'demo', model: 'fixture-model' },
      { id: 'verifier', role: 'verifier', providerId: 'demo', model: 'fixture-model' },
      { id: 'chair', role: 'chair', providerId: 'demo', model: 'fixture-model' },
    ],
    evidence: [
      {
        id: 'source-1',
        source: 'fixture://canonical-example',
        observedAt: '2026-10-07T00:00:00.000Z',
        kind: 'source_html',
        excerpt:
          '<!doctype html><html><head><link rel="canonical" href="https://example.test/services/"></head><body><h1>Services</h1></body></html>',
      },
    ],
  });
}
