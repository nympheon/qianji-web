import type { Env } from './env';
import { passwordLogin } from '../features/connection/use-cases';

export { QianjiState } from '../actor/QianjiState';

export default {
  async fetch(request, env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/connection/login') return passwordLogin(request, env);
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
