import './fixtures/no-dispatch.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { parseRobots, decideRobots } from '../dist/robots.js';
import { collectPublicCrawl } from '../dist/public-crawl.js';
import { scope, seed, robotsUrl, response, fakeTransport } from './fixtures/crawl.mjs';

const coordinator = {
  use: async (_cap, signal, fn) => {
    signal.throwIfAborted();
    return fn();
  },
};
const instant = Date.parse('2026-10-08T12:00:00Z');

for (const suffix of ['\u00a0', '\u2003', '\ufeff']) {
  const label = 'U+' + suffix.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
  test('CF-C1 preserves ' + label + ' path octets and cannot broaden an Allow rule', () => {
    const text = 'User-agent: *\nDisallow: /Start\nAllow: /Start' + suffix;
    const policy = parseRobots(text);
    assert.deepEqual(policy.diagnostics, []);
    assert.deepEqual(
      policy.rules.map((rule) => rule.path),
      ['/Start', '/Start' + suffix],
    );
    assert.equal(policy.sha256, createHash('sha256').update(text, 'utf8').digest('hex'));
    const denied = decideRobots(policy, new URL(seed));
    assert.equal(denied.decision, 'disallow');
    assert.equal(denied.matchedRule.path, '/Start');
    for (const path of ['/Start' + suffix, '/Start' + encodeURIComponent(suffix)]) {
      const allowed = decideRobots(policy, new URL(path, 'https://example.test'));
      assert.equal(allowed.decision, 'allow');
      assert.equal(allowed.matchedRule.path, '/Start' + suffix);
    }
    const disallow = parseRobots('User-agent: *\nDisallow: /Start' + suffix);
    assert.equal(disallow.rules[0].path, '/Start' + suffix);
    assert.equal(decideRobots(disallow, new URL(seed)).decision, 'allow');
    assert.equal(
      decideRobots(disallow, new URL('/Start' + suffix, 'https://example.test')).decision,
      'disallow',
    );
  });

  test('CF-C1 ' + label + ' Allow suffix never dispatches the disallowed seed', async () => {
    const text = 'User-agent: *\nDisallow: /Start\nAllow: /Start' + suffix;
    const fake = fakeTransport({
      [robotsUrl]: response(text, 'text/plain; charset=utf-8'),
      [seed]: response('This robots-disallowed fixture must never be dispatched.'),
    });
    const result = await collectPublicCrawl(
      scope,
      coordinator,
      new AbortController().signal,
      fake.transport,
      () => instant,
    );
    assert.deepEqual(
      fake.calls.map((call) => call.url),
      [robotsUrl],
    );
    assert.equal(result.requests, 1);
    assert.equal(result.pages, 0);
    const decision = result.observations.find((item) => item.report.type === 'robots_decision');
    assert.equal(decision.report.decision, 'disallow');
    assert.equal(decision.report.matchedRule.path, '/Start');
  });

  test('CF-C1 ' + label + ' around record/agent syntax is explicit HOLD', () => {
    const malformed = [
      suffix + 'User-agent: *\nAllow: /',
      'User-agent' + suffix + ': *\nAllow: /',
      'User-agent: ' + suffix + '*\nAllow: /',
      'User-agent: *' + suffix + '\nAllow: /',
      'User-agent: *\n' + suffix + 'Disallow: /Start\nAllow: /',
      'User-agent: *\nDisallow' + suffix + ': /Start\nAllow: /',
      'User-agent: *\nDisallow: ' + suffix + '/Start\nAllow: /',
      'User-agent: *\nDisallow: ' + suffix + '\nAllow: /',
      'User-agent: *\n' + suffix + '\nAllow: /',
    ];
    for (const text of malformed) {
      const policy = parseRobots(text);
      assert.ok(policy.diagnostics.length > 0, JSON.stringify(text));
      assert.equal(decideRobots(policy, new URL(seed)).decision, 'HOLD', JSON.stringify(text));
    }
  });

  test('CF-C1 ' + label + ' malformed agent cannot supply a crawl allowance', async () => {
    const fake = fakeTransport({
      [robotsUrl]: response('User-agent: *' + suffix + '\nAllow: /', 'text/plain'),
      [seed]: response('This unsupported-policy fixture must never be dispatched.'),
    });
    const result = await collectPublicCrawl(
      scope,
      coordinator,
      new AbortController().signal,
      fake.transport,
      () => instant,
    );
    assert.deepEqual(
      fake.calls.map((call) => call.url),
      [robotsUrl],
    );
    assert.equal(result.completion.status, 'HOLD');
    assert.ok(result.completion.reasons.includes('ROBOTS_UNSUPPORTED_OR_MALFORMED'));
  });
}

test('CF-C1 accepts only SP/HTAB formatting and preserves Unicode before comments', () => {
  const text =
    ' \tUser-Agent \t: \t* \t# group\r\n\tDisallow \t: \t/Start \t# rule\r\n' +
    '\tAllow \t: \t/Start\u00a0\u2003\ufeff \t# comment\u00a0\u2003\ufeff';
  const policy = parseRobots(text);
  assert.deepEqual(policy.diagnostics, []);
  assert.deepEqual(
    policy.rules.map((rule) => rule.path),
    ['/Start', '/Start\u00a0\u2003\ufeff'],
  );
  assert.equal(decideRobots(policy, new URL(seed)).decision, 'disallow');
  const empty = parseRobots(' \t# comment\u00a0\n \t\nUser-agent:\t* \t\nDisallow: \t');
  assert.deepEqual(empty.diagnostics, []);
  assert.deepEqual(empty.rules, []);
});
