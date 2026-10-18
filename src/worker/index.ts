import type { Env } from './env';

export { QianjiState } from '../actor/QianjiState';

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/health') {
      return Response.json({ status: 'ok', service: 'qianji' }, {
        headers: { 'cache-control': 'no-store' },
      });
    }
    if (pathname.startsWith('/api/') || pathname === '/mcp' || pathname.startsWith('/mcp/')) {
      return Response.json({ error: { code: 'NOT_FOUND' } }, {
        status: 404,
        headers: { 'cache-control': 'no-store' },
      });
    }
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
