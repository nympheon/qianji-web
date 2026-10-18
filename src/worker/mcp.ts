import { createMcpHandler, McpServer, type StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { actionDefinitions, actionSchemas, type ActionName } from '../contracts/actions';
import { dynamicHeaders } from './http';
import type { Env } from './env';
import { appReplySchema } from '../shared/reply';
import { isMcpAction,absoluteMcpLinks } from './mcp-contract';

export async function handleMcp(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'qianji', version: '0.1.0' }, { capabilities: { tools: {} } });
    for (const action of Object.keys(actionDefinitions) as ActionName[]) {
      if(!isMcpAction(action))continue;
      const definition = actionDefinitions[action];
      const schema: StandardSchemaWithJSON = actionSchemas[action];
      server.registerTool<StandardSchemaWithJSON, StandardSchemaWithJSON>(action, { title: definition.title, description: definition.description, inputSchema: schema, annotations: { readOnlyHint: definition.readOnly, destructiveHint: definition.destructive, idempotentHint: definition.readOnly || definition.kind === 'sync' || definition.kind === 'write', openWorldHint: true } }, async (input: unknown) => {
        const reply = appReplySchema.parse(absoluteMcpLinks(JSON.parse(await env.QIANJI_STATE.getByName('personal').call(action, input)),new URL(request.url).origin));
        return { content: [{ type: 'text', text: JSON.stringify(reply) }], structuredContent: { ...reply }, isError: reply.status === 'error' || reply.status === 'unavailable' };
      });
    }
    return server;
  }, { legacy: 'stateless', maxRequestBodySize: 12 * 1024 * 1024 });
  const response = await handler.fetch(request), headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(dynamicHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
