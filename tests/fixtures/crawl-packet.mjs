import './no-dispatch.mjs';
import { collectPublicCrawl } from '../../dist/public-crawl.js';
import { scope, seed, next, robotsUrl, response, fakeTransport } from './crawl.mjs';
const fake = fakeTransport({
  [robotsUrl]: response('User-agent: *\nAllow: /', 'text/plain'),
  [seed]: response('<title>日本語 &lt;script&gt; inert</title><a href="' + next + '">next</a>'),
  [next]: response('text', 'text/plain'),
});
const result = await collectPublicCrawl(
  scope,
  {
    use: async (_cap, signal, fn) => {
      signal.throwIfAborted();
      return fn();
    },
  },
  new AbortController().signal,
  fake.transport,
);
const { collector, permission, resources, maxObservations } = scope;
console.log(
  JSON.stringify({
    scope: { collector, permission, resources, maxObservations, maxBytes: 200000 },
    observations: result.evidence,
  }),
);
