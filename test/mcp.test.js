import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server.js';

test('MCP initialize/listTools/callTool contracts expose only the supported consumer actions', async () => {
  // Exercise the real SDK validation/transport without requiring a personal account or paid model call.
  const calls = []; const server = createMcpServer(async (method, args) => { calls.push({ method, args });
    if (method === 'media_get') return { mediaId: args.mediaId, _images: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }] };
    return { authenticated: false, authState: 'login_required' }; });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1' });
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.slice(0, 5).map(t => t.name), ['ozon_auth_open', 'ozon_auth_status', 'ozon_auth_save', 'ozon_search', 'ozon_product']);
    assert.ok(tools.some(t => t.name === 'ozon_checkout_prepare'));
    assert.ok(tools.some(t => t.name === 'ozon_reviews'));
    assert.ok(!tools.some(t => /browser_click|evaluate|raw_http/.test(t.name)));
    assert.equal(tools.find(t => t.name === 'ozon_action_confirm').annotations.destructiveHint, true);
    const status = await client.callTool({ name: 'ozon_auth_status', arguments: {} });
    assert.equal(status.structuredContent.authenticated, false);
    const invalid = await client.callTool({ name: 'ozon_search', arguments: { query: 'кондиционер', limit: 99 } });
    assert.equal(invalid.isError, true); assert.equal(calls.length, 1);
    assert.equal(tools.find(t => t.name === 'ozon_search').annotations.readOnlyHint, true);
    // Image bytes belong in MCP image blocks, never duplicated into JSON/text.
    const photo = await client.callTool({ name: 'ozon_media_get', arguments: { mediaId: 'fixture' } });
    assert.equal(photo.content.filter(block => block.type === 'image').length, 1);
    assert.equal(photo.structuredContent._images, undefined);
    assert.ok(!photo.content[0].text.includes('iVBOR'));
  } finally { await client.close(); await server.close(); }
});
