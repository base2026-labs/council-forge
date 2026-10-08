import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { createHash } from 'node:crypto';
import { fail, CouncilError } from './policy.ts';
import { boundJson } from './evidence-validation.ts';
type Node = DefaultTreeAdapterMap['node'];
export function inspectDom(
  html: string,
  url: string,
  limits = { maxDepth: 256, maxNodes: 20000, maxFacts: 100 },
) {
  if (Buffer.byteLength(html) > 2000000)
    fail('HTML_TOO_LARGE', 'Source inspection is limited to 2 MiB.');
  const source = new URL(url);
  if (!['https:', 'http:'].includes(source.protocol))
    fail('INVALID_SOURCE_URL', 'Only HTTP(S) document identifiers are accepted.');
  const canonicals: string[] = [],
    robots: string[] = [],
    titles: string[] = [],
    h1s: string[] = [],
    jsonLd: Array<{ validJson: boolean; types: string[] }> = [];
  let images = 0,
    missingAlt = 0,
    emptyAlt = 0;
  let facts = 0;
  const fact = <T>(list: T[], value: T) => {
    if (++facts > limits.maxFacts || (typeof value === 'string' && value.length > 2000))
      fail('COLLECTION_LIMIT', 'Document facts exceed the count or field bound.');
    list.push(value);
  };
  const text = (n: Node): string => {
    const pending = [n],
      parts: string[] = [];
    while (pending.length) {
      const next = pending.pop()!;
      if ('value' in next) parts.push(String(next.value));
      else if ('childNodes' in next) pending.push(...[...next.childNodes].reverse());
    }
    return parts.join('');
  };
  const stack: Array<{ node: Node; depth: number; inert?: boolean }> = [
    { node: parse(html), depth: 0 },
  ];
  let nodes = 0;
  while (stack.length) {
    const { node: n, depth, inert } = stack.pop()!;
    if (++nodes > limits.maxNodes || depth > limits.maxDepth)
      fail('COLLECTION_LIMIT', 'Document exceeds the node/depth bound.');
    if ('tagName' in n && !inert) {
      const attrs = Object.fromEntries(n.attrs.map((a) => [a.name, a.value]));
      if (
        n.tagName === 'link' &&
        attrs.rel?.toLowerCase().split(/\s+/).includes('canonical') &&
        attrs.href
      )
        fact(canonicals, attrs.href);
      if (
        n.tagName === 'meta' &&
        ['robots', 'googlebot'].includes(attrs.name?.toLowerCase() ?? '') &&
        attrs.content
      )
        fact(robots, attrs.content);
      if (n.tagName === 'title') fact(titles, text(n).trim());
      if (n.tagName === 'h1') fact(h1s, text(n).trim());
      if (n.tagName === 'img') {
        images++;
        if (!('alt' in attrs)) missingAlt++;
        else if (attrs.alt === '') emptyAlt++;
      }
      if (n.tagName === 'script' && attrs.type === 'application/ld+json') {
        try {
          const data: unknown = JSON.parse(text(n));
          boundJson(data, 2000000, limits.maxDepth, limits.maxNodes);
          const types: string[] = [];
          const pending: unknown[] = [data];
          while (pending.length) {
            const v = pending.pop();
            if (Array.isArray(v)) {
              pending.push(...[...v].reverse());
              continue;
            }
            if (v && typeof v === 'object') {
              const o = v as Record<string, unknown>;
              if (typeof o['@type'] === 'string') fact(types, o['@type']);
              else if (Array.isArray(o['@type']))
                for (const t of o['@type']) if (typeof t === 'string') fact(types, t);
              if (o['@graph']) pending.push(o['@graph']);
            }
          }
          fact(jsonLd, { validJson: true, types });
        } catch (e) {
          if (e instanceof CouncilError) throw e;
          fact(jsonLd, { validJson: false, types: [] });
        }
      }
    }
    if ('childNodes' in n)
      for (let i = n.childNodes.length - 1; i >= 0; i--)
        stack.push({ node: n.childNodes[i]!, depth: depth + 1, inert });
    if ('content' in n)
      stack.push({
        node: (n as DefaultTreeAdapterMap['template']).content,
        depth: depth + 1,
        inert: true,
      });
  }
  return {
    canonicals,
    robots,
    titles,
    h1s,
    images: { total: images, missingAlt, emptyAlt },
    jsonLd,
  };
}
export function inspectHtml(html: string, url: string) {
  const { canonicals, robots, titles, h1s, images, jsonLd } = inspectDom(html, url);
  return {
    scope: 'provided_source_html_only',
    source: url,
    sha256: createHash('sha256').update(html).digest('hex'),
    canonicals,
    robots,
    titles,
    h1s,
    images,
    jsonLd,
    notChecked: [
      'HTTP status or headers',
      'robots.txt',
      'rendered DOM or JavaScript',
      'Google-selected canonical',
      'indexing status',
      'Core Web Vitals',
      'hreflang reciprocity',
      'rich-result eligibility',
      'content truth or business claims',
    ],
    warnings: [
      ...(canonicals.length > 1 ? ['Multiple canonical links are present.'] : []),
      ...(images.missingAlt
        ? ['Some source image elements lack an alt attribute; contextual review is required.']
        : []),
    ],
  };
}
