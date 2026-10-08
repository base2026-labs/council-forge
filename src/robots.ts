import { createHash } from 'node:crypto';

export const ROBOTS_PRODUCT = 'CouncilForge';
export type RobotsRule = { directive: 'allow' | 'disallow'; path: string; line: number };
export type RobotsPolicy = {
  rules: RobotsRule[];
  groups: string[][];
  diagnostics: Array<{ line: number; reason: string }>;
  diagnosticsTruncated: boolean;
  sitemaps: string[];
  sha256: string;
};
// Deliberately bounded support, NOT a claim of full RFC 9309 conformance.
// Unknown/malformed records make an allow decision HOLD, never silently allow.
export function parseRobots(text: string): RobotsPolicy {
  const diagnostics: RobotsPolicy['diagnostics'] = [];
  let diagnosticsTruncated = false;
  const issue = (line: number, reason: string) => {
    if (diagnostics.length < 20) diagnostics.push({ line, reason });
    else diagnosticsTruncated = true;
  };
  const policy: RobotsPolicy = {
    rules: [],
    groups: [],
    diagnostics,
    diagnosticsTruncated,
    sitemaps: [],
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
  };
  if (Buffer.byteLength(text) > 200000) {
    issue(0, 'ROBOTS_PARSE_BYTES');
    return policy;
  }
  const lines = text.split(/\r\n|\r|\n/);
  const groups: Array<{ agents: string[]; rules: RobotsRule[]; hasRules: boolean }> = [];
  let group: (typeof groups)[number] | undefined,
    ruleCount = 0;
  for (const [i, raw] of lines.entries()) {
    if (i >= 1000) {
      issue(i + 1, 'ROBOTS_LINE_LIMIT');
      break;
    }
    if (Buffer.byteLength(raw) > 2048) {
      issue(i + 1, 'ROBOTS_LINE_BYTES');
      continue;
    }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\uD800-\uDFFF]/u.test(raw)) {
      issue(i + 1, 'ROBOTS_INVALID_CHARACTER');
      continue;
    }
    const line = raw.split('#', 1)[0]!.trim();
    if (!line) continue;
    const match = /^([a-zA-Z-]+)[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!match) {
      issue(i + 1, 'ROBOTS_MALFORMED_RECORD');
      continue;
    }
    const field = match[1]!.toLowerCase(),
      value = match[2]!.trim();
    if (field === 'user-agent') {
      if (!/^(\*|[a-zA-Z_-]+)$/.test(value)) {
        issue(i + 1, 'ROBOTS_UNSUPPORTED_AGENT');
        continue;
      }
      if (!group || group.hasRules) {
        group = { agents: [], rules: [], hasRules: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (field === 'allow' || field === 'disallow') {
      if (!group) {
        issue(i + 1, 'ROBOTS_ORPHAN_RULE');
        continue;
      }
      group.hasRules = true;
      if (!value) continue; // Empty paths impose no restriction.
      if (
        !value.startsWith('/') ||
        /[ \t]/.test(value) ||
        /%(?![a-fA-F0-9]{2})/.test(value) ||
        /\$(?!$)/.test(value) ||
        Buffer.byteLength(value) > 512
      ) {
        issue(i + 1, 'ROBOTS_UNSUPPORTED_PATH');
        continue;
      }
      if (++ruleCount > 200) {
        issue(i + 1, 'ROBOTS_RULE_LIMIT');
        continue;
      }
      group.rules.push({ directive: field, path: value, line: i + 1 });
    } else if (field === 'sitemap') {
      // References are data, never authorization or traversal seeds. Do not end a group.
      if (policy.sitemaps.length < 20 && value.length <= 500) policy.sitemaps.push(value);
      else issue(i + 1, 'ROBOTS_SITEMAP_LIMIT');
    } else issue(i + 1, 'ROBOTS_UNSUPPORTED_RECORD');
  }
  const exact = groups.filter((g) => g.agents.includes(ROBOTS_PRODUCT.toLowerCase()));
  const selected = exact.length ? exact : groups.filter((g) => g.agents.includes('*'));
  policy.groups = selected.map((g) => g.agents);
  policy.rules = selected.flatMap((g) => g.rules);
  policy.diagnosticsTruncated = diagnosticsTruncated;
  return policy;
}
// Preserve encoded reserved octets and path/query case. Normalize ONLY percent-encoded
// unreserved ASCII and percent hex case; Unicode becomes UTF-8 percent octets.
function comparison(value: string, pattern = false): string {
  return value.replace(/%[a-fA-F0-9]{2}|[^\x00-\x7f]|[*$]/gu, (part) => {
    if (part === '*' || part === '$') return pattern ? part : part === '*' ? '%2A' : '%24';
    if (part.startsWith('%')) {
      const c = String.fromCharCode(parseInt(part.slice(1), 16));
      return /^[a-zA-Z0-9._~-]$/.test(c) ? c : part.toUpperCase();
    }
    return encodeURIComponent(part);
  });
}
function matches(pattern: string, target: string): boolean {
  const anchored = pattern.endsWith('$');
  const p = anchored ? pattern.slice(0, -1) : pattern;
  let i = 0,
    j = 0,
    star = -1,
    retry = 0;
  while (j < target.length) {
    if (i === p.length) {
      if (!anchored) return true;
    } else if (p[i] === '*') {
      star = i++;
      retry = j;
      continue;
    } else if (p[i] === target[j]) {
      i++;
      j++;
      continue;
    }
    if (star < 0) return false;
    i = star + 1;
    j = ++retry;
  }
  while (p[i] === '*') i++;
  return i === p.length;
}
export function decideRobots(policy: RobotsPolicy, url: URL) {
  if (policy.diagnostics.length || policy.diagnosticsTruncated)
    return {
      decision: 'HOLD' as const,
      reason: 'ROBOTS_UNSUPPORTED_OR_MALFORMED',
      matchedRule: null,
    };
  const path = comparison(url.pathname + url.search);
  const matched = policy.rules.filter((r) => matches(comparison(r.path, true), path));
  const length = (r: RobotsRule) =>
    comparison(r.path, true)
      .replace(/\$$/, '')
      .replace(/%[A-F0-9]{2}/g, 'x').length;
  matched.sort(
    (a, b) =>
      length(b) - length(a) || (a.directive === b.directive ? 0 : a.directive === 'allow' ? -1 : 1),
  );
  const rule = matched[0] ?? null;
  if (
    rule &&
    matched.some(
      (r) =>
        length(r) === length(rule) &&
        r.directive !== rule.directive &&
        comparison(r.path, true) !== comparison(rule.path, true),
    )
  )
    return { decision: 'HOLD' as const, reason: 'ROBOTS_AMBIGUOUS_MATCH', matchedRule: null };
  return {
    decision: rule?.directive === 'disallow' ? ('disallow' as const) : ('allow' as const),
    reason: rule ? 'ROBOTS_MATCHED_RULE' : 'ROBOTS_NO_MATCHING_RULE',
    matchedRule: rule,
  };
}
