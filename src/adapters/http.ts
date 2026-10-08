import { CouncilError, fail } from '../policy.ts';
import { ProviderResponseError, reportedReceipt } from '../provider.ts';
export function httpsEndpoint(base: string, suffix: string): URL {
  const url = new URL(base.endsWith('/') ? base : base + '/');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    fail(
      'UNSAFE_ENDPOINT',
      'Provider base URL must be HTTPS without embedded credentials, query or fragment.',
    );
  return new URL(suffix, url);
}
export function envSecret(name: string): string {
  const value = process.env[name];
  if (!value)
    return fail('CREDENTIAL_MISSING', 'The server-side provider credential is not configured.');
  return value;
}
export async function jsonFetch(
  url: URL,
  init: RequestInit,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const response = await fetcher(url, { ...init, redirect: 'error' });
  const rejected = !response.ok
    ? new CouncilError(
        `HTTP_${response.status}`,
        'Provider request failed. Body omitted to avoid leaking private content.',
      )
    : null;
  if (!response.body) {
    if (rejected) throw rejected;
    return fail('EMPTY_RESPONSE', 'Provider returned no body.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1048576) fail('RESPONSE_TOO_LARGE', 'Provider response exceeds 1 MiB.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    throw rejected ?? error;
  }
  if (rejected) throw new ProviderResponseError(rejected, reportedReceipt(raw));
  return raw;
}
