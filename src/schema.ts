import { z } from 'zod';
export const Identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
export const Mode = z.enum(['subscription_only', 'api_only', 'hybrid']);
export const Role = z.enum([
  'architect',
  'technical_seo',
  'researcher',
  'geo_aeo',
  'indexation',
  'serp',
  'schema',
  'content',
  'evidence_hunter',
  'implementation',
  'skeptic',
  'verifier',
  'chair',
]);
export const Effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export const Language = z
  .string()
  .min(2)
  .max(35)
  .refine((value) => {
    try {
      return Intl.getCanonicalLocales(value).length === 1;
    } catch {
      return false;
    }
  }, 'Use a valid BCP 47 output language tag.');
export const EvidenceKind = z.enum([
  'source_html',
  'rendered_html',
  'gsc',
  'crawl',
  'document',
  'test',
  'diff',
  'provider_metric',
  'serp',
  'hypothesis',
]);
export const ModelSchema = z
  .object({
    id: z.string().min(1).max(180),
    label: z.string().min(1).max(120),
    efforts: z.array(Effort).max(7).default([]),
    responseIds: z.array(z.string().min(1).max(180)).min(1).max(20),
    inputUsdPerMillion: z.number().finite().nonnegative().optional(),
    outputUsdPerMillion: z.number().finite().nonnegative().optional(),
    priceAsOf: z.iso.datetime().optional(),
    jsonMode: z.boolean().default(false),
  })
  .strict();
export const ProviderSchema = z
  .object({
    id: Identifier,
    kind: z.enum(['mock', 'codex-local', 'openrouter', 'openai-compatible']),
    models: z.array(ModelSchema).min(1).max(100),
    baseUrl: z.url().optional(),
    keyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,100}$/)
      .optional(),
    codexExecutable: z.string().min(1).optional(),
    codexHome: z.string().min(1).optional(),
  })
  .strict();
export const JevSchema = z
  .object({
    enabled: z.boolean().default(false),
    model: z.string().default('typesafe/jev-1.13-20260917'),
    keyEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,100}$/)
      .default('OPENROUTER_API_KEY'),
    confidenceThreshold: z.number().min(0).max(1).default(0.9),
    reservationUsd: z.number().positive().max(1).default(0.01),
  })
  .strict();
export const SettingsSchema = z
  .object({
    providers: z.array(ProviderSchema).min(1).max(20),
    allowedModes: z.array(Mode).min(1).default(['subscription_only']),
    maxAgents: z.number().int().min(4).max(32).default(16),
    maxConcurrency: z.number().int().min(1).max(3).default(3),
    maxCallsPerRun: z.number().int().min(4).max(64).default(24),
    apiLifetimeLimitUsd: z.number().finite().nonnegative().default(0),
    maxRunApiUsd: z.number().finite().nonnegative().default(0),
    maxPriceAgeHours: z.number().positive().max(720).default(168),
    liveEnabled: z.boolean().default(false),
    outputLanguage: Language.default('en'),
    jev: JevSchema.default({
      enabled: false,
      model: 'typesafe/jev-1.13-20260917',
      keyEnv: 'OPENROUTER_API_KEY',
      confidenceThreshold: 0.9,
      reservationUsd: 0.01,
    }),
  })
  .strict();
export const AgentSchema = z
  .object({
    id: Identifier,
    role: Role,
    providerId: Identifier,
    model: z.string().min(1).max(180),
    effort: Effort.optional(),
    instances: z.number().int().min(1).max(10).default(1),
  })
  .strict();
export const EvidenceSchema = z
  .object({
    id: Identifier,
    source: z.string().min(1).max(500),
    observedAt: z.iso.datetime(),
    kind: EvidenceKind,
    excerpt: z.string().min(1).max(20000),
    provenance: z
      .object({
        collector: Identifier,
        scope: z.string().min(1).max(500),
        permission: z.literal('read'),
        sourceReported: z.boolean(),
        limitations: z.array(z.string().min(1).max(2000)).max(20),
      })
      .strict()
      .optional(),
  })
  .strict();
export const RequestSchema = z
  .object({
    runId: Identifier,
    task: z.string().min(1).max(16000),
    kind: z.enum(['seo_audit', 'code_review', 'research', 'architecture']).default('research'),
    mode: Mode.default('subscription_only'),
    agents: z.array(AgentSchema).min(4).max(32),
    evidence: z.array(EvidenceSchema).max(100).default([]),
    apiBudgetUsd: z.number().finite().nonnegative().default(0),
    maxOutputTokens: z.number().int().min(256).max(4096).default(1536),
    timeoutMs: z.number().int().min(1000).max(600000).default(120000),
    useJev: z.boolean().default(false),
    outputLanguage: Language.optional(),
    permissionScope: z.literal('read_only').default('read_only'),
  })
  .strict();
export const ClaimSchema = z
  .object({ text: z.string().min(1).max(2000), evidenceIds: z.array(Identifier).max(20) })
  .strict();
export const ObjectionSchema = z
  .object({
    text: z.string().min(1).max(2000),
    severity: z.enum(['minor', 'major', 'critical']),
    claimId: Identifier.nullish(),
  })
  .strict();
export const OpinionSchema = z
  .object({
    summary: z.string().max(4000),
    claims: z.array(ClaimSchema).max(20),
    objections: z.array(ObjectionSchema).max(20),
  })
  .strict();
export const VerificationSchema = z
  .object({
    checks: z
      .array(
        z
          .object({
            claimId: Identifier,
            verdict: z.enum(['supported', 'contradicted', 'unknown']),
            evidenceIds: z.array(Identifier).max(20),
            note: z.string().max(2000),
          })
          .strict(),
      )
      .max(300),
    limitations: z.array(z.string().max(2000)).max(20),
  })
  .strict();
export const ChairSchema = z
  .object({
    recommendation: z.string().max(8000),
    reasons: z.array(z.string().max(2000)).max(20),
    nextActions: z.array(z.string().max(2000)).max(20),
  })
  .strict();
export type Settings = z.infer<typeof SettingsSchema>;
export type ProviderSettings = z.infer<typeof ProviderSchema>;
export type ModelSettings = z.infer<typeof ModelSchema>;
export type Agent = z.infer<typeof AgentSchema>;
export type CouncilRequest = z.infer<typeof RequestSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Opinion = z.infer<typeof OpinionSchema>;
export type Verification = z.infer<typeof VerificationSchema>;
export type Claim = z.infer<typeof ClaimSchema> & { id: string };
