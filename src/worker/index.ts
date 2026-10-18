import type { Env } from './env';
import { passwordLogin } from '../features/connection/use-cases';
import { handleActionHttp } from './http';
import { handleMcp } from './mcp';

export { QianjiState } from '../actor/QianjiState';

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/api/connection/login') return passwordLogin(request, env);
    if (pathname === '/api/actions') return handleActionHttp(request, env);
    if (pathname === '/mcp') return handleMcp(request, env, ctx);
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
