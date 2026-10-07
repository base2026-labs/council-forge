import { z } from 'zod';
import { AgentSchema, type Agent } from './schema.ts';
import { fail } from './policy.ts';
export const PresetName = z.enum(['research', 'seo_geo_aeo', 'code_review']);
const reviews: Agent['role'][] = ['skeptic', 'verifier', 'chair'];
const presets: Record<z.infer<typeof PresetName>, Agent['role'][]> = {
  research: ['researcher', 'evidence_hunter', ...reviews],
  seo_geo_aeo: [
    'technical_seo',
    'indexation',
    'serp',
    'geo_aeo',
    'schema',
    'content',
    'evidence_hunter',
    'implementation',
    ...reviews,
  ],
  code_review: ['architect', 'implementation', ...reviews],
};
export function createPreset(name: unknown, selections: unknown): Agent[] {
  const roles = presets[PresetName.parse(name)];
  const selected = z.array(AgentSchema).max(32).parse(selections);
  if (
    selected.length !== roles.length ||
    new Set(selected.map((a) => a.role)).size !== roles.length ||
    selected.some((a) => !roles.includes(a.role))
  )
    fail(
      'PRESET_SELECTIONS',
      'Supply one explicit provider/model/effort/instance selection for every preset role.',
    );
  for (const agent of selected) {
    if (!agent.effort) fail('EFFORT_REQUIRED', 'Presets require explicit reasoning effort.');
    if (reviews.includes(agent.role) && agent.instances !== 1)
      fail('REQUIRED_ROLE', 'Each mandatory review role has one instance.');
  }
  return roles.map((role) => selected.find((a) => a.role === role)!);
}
export const presetContracts = () =>
  Object.entries(presets).map(([name, roles]) => ({
    name,
    roles,
    permissionScope: 'read_only',
    mandatoryReview: reviews,
  }));
