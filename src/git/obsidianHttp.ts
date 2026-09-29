import type { GitHttpRequest, GitHttpResponse, HttpClient } from "isomorphic-git";

/** The slice of Obsidian's `requestUrl` we use. */
export type RequestUrlFn = (p: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: ArrayBuffer;
  throw?: boolean;
}) => Promise<{ status: number; headers: Record<string, string>; arrayBuffer: ArrayBuffer }>;

async function collect(body: AsyncIterableIterator<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let len = 0;
  for await (const c of body) {
    parts.push(c);
    len += c.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * isomorphic-git HTTP client over Obsidian's `requestUrl`. requestUrl bypasses browser CORS (git hosts
 * don't send CORS headers), which is why the default fetch-based client can't be used on mobile.
 * Bodies are buffered whole: fine for note vaults, but a very large first push costs memory on phones.
 */
export function createObsidianHttp(requestUrl: RequestUrlFn): HttpClient {
  return {
    async request(req: GitHttpRequest): Promise<GitHttpResponse> {
      let body: ArrayBuffer | undefined;
      if (req.body) {
        const bytes = await collect(req.body as AsyncIterableIterator<Uint8Array>);
        body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      }
      const res = await requestUrl({
        url: req.url,
        method: req.method ?? "GET",
        headers: req.headers,
        body,
        throw: false, // git relies on seeing 401/404 status codes itself
      });
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) headers[k.toLowerCase()] = v;
      const payload = new Uint8Array(res.arrayBuffer);
      return {
        url: req.url,
        method: req.method,
        statusCode: res.status,
        statusMessage: String(res.status),
        headers,
        body: (async function* () {
          yield payload;
        })(),
      };
    },
  };
}
