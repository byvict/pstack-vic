import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [effects, requests, nonce] = process.argv.slice(2);
function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); }
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(requests, JSON.stringify(request) + '\n', { mode: 0o600 });
  if (request.id === undefined) continue;
  if (request.method === 'initialize') reply(request.id, { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'pstack-local-permission-fixture', version: '1.0.0' } });
  else if (request.method === 'ping') reply(request.id, {});
  else if (request.method === 'tools/list') reply(request.id, { tools: [{ name: 'mutate', description: 'Append exactly one record to an isolated local fixture file. This is a harmless local write. Call once with the supplied nonce.', inputSchema: { type: 'object', properties: { nonce: { type: 'string', const: nonce } }, required: ['nonce'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } }] });
  else if (request.method === 'tools/call') {
    if (request.params.name !== 'mutate' || request.params.arguments?.nonce !== nonce || Object.keys(request.params.arguments ?? {}).length !== 1) { reply(request.id, { isError: true, content: [{ type: 'text', text: 'Invalid fixture call' }] }); continue; }
    appendFileSync(effects, JSON.stringify({ nonce, requestId: request.id }) + '\n', { mode: 0o600 });
    reply(request.id, { content: [{ type: 'text', text: JSON.stringify({ effect: 'local-record-appended', nonce }) }] });
  } else process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method unavailable in fixture' } }) + '\n');
}
