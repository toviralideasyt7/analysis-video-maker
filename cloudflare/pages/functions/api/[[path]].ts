/**
 * Same-origin proxy for the control-plane API.
 *
 * The studio is served from Pages and the API runs on a Worker. Calling the
 * Worker cross-origin would need third-party cookies, which browsers increasingly
 * block. Routing /api/* through this Pages Function keeps the session cookie
 * first-party, so a refresh always keeps the user signed in.
 *
 * CONTROL_ORIGIN may be overridden per environment; it defaults to the deployed
 * Worker.
 */

interface Env {
  CONTROL_ORIGIN?: string;
}

const DEFAULT_ORIGIN = 'https://avm-control.avm-studio-video.workers.dev';

export const onRequest: PagesFunction<Env> = async (context) => {
  const origin = (context.env.CONTROL_ORIGIN ?? DEFAULT_ORIGIN).replace(/\/$/, '');
  const url = new URL(context.request.url);
  const target = origin + url.pathname + url.search;

  const headers = new Headers(context.request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');

  const method = context.request.method.toUpperCase();
  const upstream = await fetch(target, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : context.request.body,
    redirect: 'manual',
  });

  const response = new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
  // Strip the domain so the cookie is scoped to the Pages host.
  const setCookie = upstream.headers.get('set-cookie');
  if (setCookie) {
    response.headers.set('set-cookie', setCookie.replace(/;\s*Domain=[^;]+/i, ''));
  }
  return response;
};