import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const allowed = new Set([
  'mt_apk_read_text', 'mt_apk_read_bytes', 'mt_apk_search', 'mt_apk_list',
  'mt_apk_dex_xref', 'mt_apk_dex_read_class_outline',
  'mt_apk_native_inspect', 'mt_apk_native_list_items', 'mt_apk_native_map_address',
  'mt_apk_native_xref', 'mt_apk_native_disassemble', 'mt_apk_native_analyze_control_flow',
]);
const { values } = parseArgs({ options: {
  tool: { type: 'string' }, 'args-file': { type: 'string' }, output: { type: 'string' },
  endpoint: { type: 'string', default: 'http://127.0.0.1:8787/mcp' },
} });
if (!values.tool || !allowed.has(values.tool) || !values['args-file'] || !values.output) {
  throw new Error('Use --tool <read-only-tool> --args-file <json-file> --output <json-file>');
}
const input: unknown = JSON.parse(await readFile(values['args-file'], 'utf8'));
if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Arguments must be an object');
const id = Date.now();
const response = await fetch(values.endpoint!, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: values.tool, arguments: input } }),
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`MT HTTP ${response.status}`);
interface RpcReply {
  id?: number;
  error?: { message: string };
  result?: { structuredContent?: unknown; content?: { type: string; text?: string }[]; isError?: boolean };
}
const text = await response.text();
const replies: RpcReply[] = text.trimStart().startsWith('{') ? [JSON.parse(text)] : text.split(/\r?\n\r?\n/)
  .map(event => event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n'))
  .filter(Boolean).map(data => JSON.parse(data) as RpcReply);
const reply = replies.find(item => item.id === id);
if (!reply || reply.error || !reply.result || reply.result.isError) throw new Error('MT read did not complete successfully');
const result = reply.result.structuredContent ?? JSON.parse(reply.result.content?.find(item => item.type === 'text')?.text ?? 'null');
if (!result || typeof result !== 'object' || (result as { ok?: boolean }).ok !== true) throw new Error('MT read returned an error');
const output = resolve(values.output);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(result, null, 2) + '\n');
console.log(`Saved read-only evidence: ${output}`);
