import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { PassThrough, Readable } from 'node:stream';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { allowedOrigins } from '../shared/http.mjs';
import type { LibrarianHttpEvent, LibrarianHttpResponse } from '../shared/http.mjs';

type Stream = PassThrough & { start?: (status: number, headers: Record<string, string>) => void; signal?: AbortSignal };
type Context = { awsRequestId: string };
type Auth = (request: LibrarianHttpEvent, context: Context) => Promise<LibrarianHttpResponse>;
type Archive = (request: LibrarianHttpEvent, stream: Stream, context: Context) => Promise<void>;

/**
 * The cache-control a native response leaves with. no-store unless the route
 * set its own value on a response nothing per-reader went into: a GET or
 * HEAD with no Authorization, Cookie, Origin or query string, answered
 * without Set-Cookie. The edge cache key holds none of the cookie, the
 * query or Origin, and CORS answers vary by Origin, so any of those keeps
 * the response out of every cache. The public identity page, favicon
 * redirects and OAuth metadata are the routes that ask to be cached.
 */
export function responseCacheControl(request: Request, response: Response) {
  const routeValue = response.headers.get('cache-control');
  if (!routeValue) return 'no-store';
  if (!['GET', 'HEAD'].includes(request.method)) return 'no-store';
  for (const header of ['authorization', 'cookie', 'origin']) if (request.headers.has(header)) return 'no-store';
  if (new URL(request.url).search) return 'no-store';
  if (response.headers.has('set-cookie')) return 'no-store';
  return routeValue;
}

/** A small request record shared with the existing routes. Native HTTP has
 * no API Gateway event or invocation context. All identity is request-local. */
export function makeServer(dispatch: { auth: Auth } | { archive: Archive }, timeoutSeconds: number) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('cache-control', responseCacheControl(c.req.raw, c.res));
    c.res.headers.set('x-content-type-options', 'nosniff');
    const origin = c.req.header('origin');
    if (origin && allowedOrigins().includes(origin)) {
      c.res.headers.set('access-control-allow-origin', origin);
      c.res.headers.set('vary', 'Origin');
      c.res.headers.set('access-control-allow-methods', 'GET, POST, OPTIONS');
      c.res.headers.set('access-control-allow-headers', 'content-type, authorization, x-librarian-contract-version');
      c.res.headers.set('access-control-expose-headers', 'x-librarian-contract-version, x-request-id');
    }
  });
  app.use('*', bodyLimit({ maxSize: 6 * 1024 * 1024 }));
  app.all('*', async (c) => {
    const url = new URL(c.req.url);
    const id = c.req.header('lambda-web-request-id') || randomUUID();
    const request: LibrarianHttpEvent = {
      native: true,
      requestId: id,
      method: c.req.method,
      path: url.pathname,
      headers: Object.fromEntries(c.req.raw.headers),
      // The session code reads cookies as "name=value" entries (the API
      // Gateway shape), so split the Cookie header into that list.
      cookies: (c.req.header('cookie') || '')
        .split(';')
        .map((entry) => entry.trim())
        .filter(Boolean),
      rawQueryString: url.search.slice(1),
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: ['GET', 'HEAD'].includes(c.req.method) ? '' : await c.req.text()
    };
    if ('auth' in dispatch) {
      const result = await dispatch.auth(request, { awsRequestId: id });
      const headers = new Headers(result.headers);
      for (const cookie of result.cookies || []) headers.append('set-cookie', cookie);
      headers.set('x-request-id', id);
      return new Response(c.req.method === 'HEAD' || [204, 304].includes(result.statusCode) ? null : result.body, {
        status: result.statusCode,
        headers
      });
    }
    const abort = new AbortController();
    const stream: Stream = new PassThrough({ highWaterMark: 64 * 1024 });
    stream.signal = abort.signal;
    stream.on('error', () => {});
    stream.on('close', () => abort.abort());
    const cancel = () => {
      abort.abort();
      stream.destroy();
    };
    c.req.raw.signal.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, timeoutSeconds * 1000);
    timer.unref();
    stream.once('close', () => {
      clearTimeout(timer);
      c.req.raw.signal.removeEventListener('abort', cancel);
    });
    return await new Promise<Response>((resolve, reject) => {
      let started = false;
      stream.once('close', () => {
        if (!started) reject(new Error('Request cancelled before headers'));
      });
      stream.start = (status, values) => {
        if (started) throw new Error('Response already started');
        started = true;
        const headers = new Headers(values);
        headers.set('x-request-id', id);
        const empty = c.req.method === 'HEAD' || [204, 304].includes(status);
        resolve(
          new Response(empty ? null : (Readable.toWeb(stream) as ReadableStream<Uint8Array>), { status, headers })
        );
        if (empty) stream.resume();
      };
      void dispatch.archive(request, stream, { awsRequestId: id }).catch(() => {
        if (!started) {
          stream.destroy();
          reject(new Error('Archive request failed'));
        } else stream.destroy();
      });
    });
  });
  app.onError((_error, c) => {
    console.error({ event: 'http_error', build: process.env.LIBRARIAN_SOURCE_REVISION });
    c.header('cache-control', 'no-store');
    return c.json({ error: 'The Librarian is temporarily unavailable. Try again shortly.' }, 503);
  });
  return app;
}

export function listen(app: Hono) {
  const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT || '127.0.0.1:8790';
  const address = new URL(endpoint.includes('://') ? endpoint : `http://${endpoint}`);
  const server = serve({ fetch: app.fetch, hostname: address.hostname, port: Number(address.port) }) as Server;
  process.once('SIGTERM', () => {
    server.close();
    setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 800).unref();
  });
  return server;
}
