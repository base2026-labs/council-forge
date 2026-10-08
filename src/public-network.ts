import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { CouncilError, fail } from './policy.ts';
export function publicHttpsUrl(value: string): URL {
  if (
    !/^https:\/\//.test(value) ||
    value.length > 500 ||
    /[\u0000-\u0020\u007f\\]/.test(value) ||
    value.slice(8).split(/[/?#]/, 1)[0]!.includes('@') ||
    /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)
  )
    fail('PUBLIC_URL_REQUIRED', 'Unsafe or ambiguous public URL spelling.');
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== '443') ||
    isIP(url.hostname) ||
    !url.hostname.includes('.') ||
    url.hostname.endsWith('.localhost')
  )
    fail(
      'PUBLIC_URL_REQUIRED',
      'Only public HTTPS domain URLs without credentials, fragments or custom ports are supported.',
    );
  return url;
}
export function isPublicIpv4(value: string): boolean {
  if (isIP(value) !== 4) return false;
  const [a, b, c] = value.split('.').map(Number) as [number, number, number, number];
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}
export type PublicResponse = {
  status: number;
  location?: string;
  contentType: string;
  cacheControl?: string;
  age?: string;
  date?: string;
  expires?: string;
  body: Buffer;
};
// Test injection is a code-level port, never an operator/model-selectable proxy.
export function createPublicTransport(ports = { lookup, request }) {
  return async function getPublicPage(
    url: URL,
    maxBytes: number,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<PublicResponse> {
    publicHttpsUrl(url.href);
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    requestSignal.throwIfAborted();
    if (maxBytes < 1) fail('COLLECTION_BYTES_EXCEEDED', 'No response byte allowance remains.');
    // Resolve once, reject private/special answers, then pin the connection to that address.
    // IPv6-only hosts are conservatively unsupported; no proxy env or credentials are used.
    const addresses = await withCancellation(
      ports.lookup(url.hostname, { family: 4, all: true }),
      requestSignal,
    );
    if (!addresses.length || addresses.some(({ address }) => !isPublicIpv4(address)))
      fail('PRIVATE_NETWORK_DENIED', 'DNS must resolve exclusively to public IPv4 addresses.');
    requestSignal.throwIfAborted();
    return new Promise<PublicResponse>((resolve, reject) => {
      const req = ports.request(
        url,
        {
          method: 'GET',
          agent: false,
          signal: requestSignal,
          maxHeaderSize: 8192,
          headers: {
            'User-Agent': 'CouncilForge/0.1 bounded-source-observation',
            Accept: 'text/html,text/plain;q=0.5',
            'Accept-Encoding': 'identity',
          },
          lookup: (host, options, callback) => {
            if (host !== url.hostname) return callback(new Error('Unexpected DNS host'), '', 4);
            if (options.all) callback(null, [addresses[0]!]);
            else callback(null, addresses[0]!.address, 4);
          },
        },
        (response) => {
          let size = 0;
          let terminated = false;
          const chunks: Buffer[] = [];
          const diagnostic = () => ({
            responseBytes: size,
            retainedBytes: chunks.reduce((n, b) => n + b.length, 0),
            responseStatus: response.statusCode ?? null,
            responseContentType: response.headers['content-type'] ?? '',
            partialSha256: createHash('sha256').update(Buffer.concat(chunks)).digest('hex'),
          });
          const terminate = (code: string, message: string) => {
            if (terminated) return;
            terminated = true;
            const error = new CouncilError(code, message, diagnostic());
            response.destroy();
            req.destroy(error);
            reject(error);
          };
          if (
            response.headers['content-encoding'] &&
            response.headers['content-encoding'] !== 'identity'
          ) {
            terminate(
              'SOURCE_ENCODING_UNSUPPORTED',
              'Compressed source responses are unsupported.',
            );
            return;
          }
          response.on('aborted', () =>
            terminate('SOURCE_STREAM_INTERRUPTED', 'Source stream interrupted; no retry.'),
          );
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) {
              const remaining = maxBytes - (size - chunk.length);
              if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
              terminate(
                'COLLECTION_BYTES_EXCEEDED',
                'Response exceeded the remaining collection byte limit.',
              );
            } else chunks.push(chunk);
          });
          response.on('error', () =>
            terminate('SOURCE_STREAM_INTERRUPTED', 'Source stream failed; no retry.'),
          );
          response.on('end', () => {
            if (!response.complete)
              return terminate('SOURCE_STREAM_INTERRUPTED', 'Incomplete HTTP response; no retry.');
            resolve({
              status: response.statusCode ?? 0,
              location: response.headers.location,
              contentType: response.headers['content-type'] ?? '',
              cacheControl: response.headers['cache-control'],
              age: response.headers.age,
              date: response.headers.date,
              expires: response.headers.expires,
              body: Buffer.concat(chunks),
            });
          });
        },
      );
      req.on('error', reject);
      req.setTimeout(timeoutMs, () =>
        req.destroy(
          new CouncilError(
            'COLLECTION_TIMEOUT',
            'Public page request timed out; no retry was attempted.',
          ),
        ),
      );
      req.end();
    });
  };
}
export const getPublicPage = createPublicTransport();
// Also used around injected transports. The promise's rejection stays observed after abort.
export async function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}
