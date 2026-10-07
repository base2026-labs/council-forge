import { fail } from './policy.ts';
// No model-supplied capability is dispatched. This list is the actual adapter
// surface, not a prompt or MCP annotation. Collectors run separately under scope.
export const councilCapabilities = () => ({
  permissionScope: 'read_only',
  modelTools: [] as string[],
  deniedSurfaces: ['repository', 'website', 'gsc', 'linear', 'external_system'],
  boundary: 'No model tool dispatcher; native subscription additionally requires host isolation.',
});
export function denyModelCapability(_name: string): never {
  return fail(
    'CAPABILITY_DENIED',
    'Council models cannot invoke tools or mutate any external system.',
  );
}
