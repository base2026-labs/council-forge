import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { createHash } from 'node:crypto';
import { fail } from './policy.ts';
type Node = DefaultTreeAdapterMap['node'];
export function inspectHtml(html: string, url: string) {
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
  const text = (n: Node): string =>
    'value' in n ? String(n.value) : 'childNodes' in n ? n.childNodes.map(text).join('') : '';
  const walk = (n: Node) => {
    if ('tagName' in n) {
      const attrs = Object.fromEntries(n.attrs.map((a) => [a.name, a.value]));
      if (
        n.tagName === 'link' &&
        attrs.rel?.toLowerCase().split(/\s+/).includes('canonical') &&
        attrs.href
      )
        canonicals.push(attrs.href);
      if (
        n.tagName === 'meta' &&
        ['robots', 'googlebot'].includes(attrs.name?.toLowerCase() ?? '') &&
        attrs.content
      )
        robots.push(attrs.content);
      if (n.tagName === 'title') titles.push(text(n).trim());
      if (n.tagName === 'h1') h1s.push(text(n).trim());
      if (n.tagName === 'img') {
        images++;
        if (!('alt' in attrs)) missingAlt++;
        else if (attrs.alt === '') emptyAlt++;
      }
      if (n.tagName === 'script' && attrs.type === 'application/ld+json') {
        try {
          const data: unknown = JSON.parse(text(n));
          const types: string[] = [];
          const collect = (v: unknown) => {
            if (Array.isArray(v)) {
              v.forEach(collect);
              return;
            }
            if (v && typeof v === 'object') {
              const o = v as Record<string, unknown>;
              if (typeof o['@type'] === 'string') types.push(o['@type']);
              else if (Array.isArray(o['@type']))
                types.push(...o['@type'].filter((t): t is string => typeof t === 'string'));
              if (o['@graph']) collect(o['@graph']);
            }
          };
          collect(data);
          jsonLd.push({ validJson: true, types });
        } catch {
          jsonLd.push({ validJson: false, types: [] });
        }
      }
    }
    if ('childNodes' in n) n.childNodes.forEach(walk);
  };
  walk(parse(html));
  return {
    scope: 'provided_source_html_only',
    source: url,
    sha256: createHash('sha256').update(html).digest('hex'),
    canonicals,
    robots,
    titles,
    h1s,
    images: { total: images, missingAlt, emptyAlt },
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
      ...(missingAlt
        ? ['Some source image elements lack an alt attribute; contextual review is required.']
        : []),
    ],
  };
}
