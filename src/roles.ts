import type { Agent, Evidence } from './schema.ts';

export interface RoleContract {
  brief: string;
  skill: string;
  capabilities: readonly ['supplied_evidence'];
  allowedEvidenceKinds: Evidence['kind'][];
  limitations: string[];
}
const contract = (brief: string, skill: string, kinds: Evidence['kind'][]): RoleContract => ({
  brief,
  skill: `skills/${skill}/SKILL.md`,
  capabilities: ['supplied_evidence'],
  allowedEvidenceKinds: kinds,
  limitations: [
    'Typed exports preserve provider reports, supplied-document facts and caller assertions separately. Null/date gaps are UNKNOWN; stale/partial observations do not establish current state or causality.',
    'No inherited user plugins or external tool access.',
    'Evidence support is fallible; missing facts require HOLD.',
    'No repository, website, GSC or external system mutations.',
  ],
});
const all: Evidence['kind'][] = [
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
];
export const ROLE_CONTRACTS: Record<Agent['role'], RoleContract> = {
  architect: contract(
    'Assess architecture, testability and implementation tradeoffs without inventing capabilities.',
    'architecture',
    ['document', 'test', 'diff'],
  ),
  technical_seo: contract(
    'Assess canonical, robots, redirects, crawlability and source/rendered differences. Source HTML does not prove Google-selected canonical or indexation causality; schema syntax does not prove rich-result eligibility.',
    'technical-seo',
    all,
  ),
  researcher: contract(
    'Evaluate dated primary sources and provenance independently. Do not pretend to browse, crawl or use tools.',
    'research',
    all,
  ),
  geo_aeo: contract(
    'Assess answer surfaces, entity coverage and cited observations for GEO/AEO. Distinguish recorded AI citations from predictions; no guaranteed rankings or citation improvements.',
    'geo-aeo',
    ['document', 'serp', 'source_html', 'rendered_html', 'provider_metric', 'hypothesis'],
  ),
  indexation: contract(
    'Compare dated GSC URL Inspection, sitemap and crawl observations. Keep Google-selected canonical, GSC user canonical and source/rendered declarations distinct. Provider indexed-version reports are not live URL tests. Unobserved index status and indexing causes remain UNKNOWN.',
    'indexation',
    ['gsc', 'crawl', 'source_html', 'rendered_html', 'document', 'hypothesis'],
  ),
  serp: contract(
    'Evaluate supplied dated SERP observations, query, market and device. Do not extrapolate a sampled rank to stable visibility or invent live search.',
    'serp',
    ['serp', 'provider_metric', 'document', 'hypothesis'],
  ),
  schema: contract(
    'Assess supplied JSON-LD and type requirements. Parse success is syntax only; rich-result eligibility needs current requirements and evidence.',
    'schema',
    ['source_html', 'rendered_html', 'document', 'test'],
  ),
  content: contract(
    'Compare intent, content gaps and potential cannibalization against supplied corpus and metrics. Distinguish editorial advice from proven traffic effects.',
    'content',
    ['document', 'source_html', 'rendered_html', 'serp', 'provider_metric', 'gsc', 'hypothesis'],
  ),
  evidence_hunter: contract(
    'Map each claim to dated observations and primary documents. Report missing evidence explicitly; no fabricated retrieval.',
    'evidence',
    all,
  ),
  implementation: contract(
    'Propose a repair and meaningful validation steps for the single implementation owner. Advice is not write authorization; do not execute or apply a patch.',
    'implementation',
    all,
  ),
  skeptic: contract(
    'Seek counterexamples, unsupported causal conclusions, security risks and gaps. One unresolved major or critical objection blocks acceptance.',
    'skeptic',
    all,
  ),
  verifier: contract(
    'Blindly check each atomic claim against supplied evidence. No solver narrative or model identity. Quoted assertions and hypotheses are not independent proof.',
    'verifier',
    all,
  ),
  chair: contract(
    'Explain the verified packet and next actions in the requested language. Do not override the deterministic gate or authorize changes.',
    'chair',
    all,
  ),
};
export const roleBrief = (role: Agent['role']) => ROLE_CONTRACTS[role].brief;
export const contracts = () => ROLE_CONTRACTS;
