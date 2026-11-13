import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/** Manual acceptance uses the public stdio interface, not internal browser
 * methods. Search is opt-in because it calls the real paid provider and site. */
const client = new Client({ name: 'ozon-smoke', version: '1.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve'], stderr: 'pipe' });
await client.connect(transport);
try {
  console.log(JSON.stringify({ tools: (await client.listTools()).tools.map(t => t.name) }));
  const auth = await client.callTool({ name: 'ozon_auth_status', arguments: {} }, undefined, { timeout: 60000 });
  console.log(JSON.stringify({ auth: auth.structuredContent ?? auth.content }));
  const [mode, value] = process.argv.slice(2);
  if (mode === '--search') {
    const search = await client.callTool({ name: 'ozon_search', arguments: { query: value ?? 'мобильные кондиционеры до 30000 руб', limit: 5 } }, undefined, { timeout: 300000 });
    if (search.isError) throw new Error(JSON.stringify(search.content));
    const data = search.structuredContent;
    console.log(JSON.stringify(data, null, 2));
    if (process.env.OZON_MCP_SMOKE_ARTIFACT) await fs.writeFile(process.env.OZON_MCP_SMOKE_ARTIFACT, JSON.stringify(data, null, 2) + '\n');
  } else if (mode === '--product') {
    const product = await client.callTool({ name: 'ozon_product', arguments: { url: value } }, undefined, { timeout: 60000 });
    if (product.isError) throw new Error(JSON.stringify(product.content));
    console.log(JSON.stringify(product.structuredContent, null, 2));
  }
} finally { await client.close(); }
