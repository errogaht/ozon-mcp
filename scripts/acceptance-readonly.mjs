import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { privateDir, stateDir } from '../src/config.js';

/** Safe live acceptance has a HARD-CODED read/preview-only list. It cannot call
 * mutation/final tools, and never prints order/account/media bodies to logs.
 * Full results stay in private files for human/agent inspection. */
const product = 'https://www.ozon.ru/product/konditsioner-mobilnyy-centek-ct-67am12-35m2-moshchnost-900vt-kompressor-highly-zavod-aux-5143476081/';
const cases = [
  ['filters', 'ozon_search_filters', { query: 'мобильный кондиционер' }],
  ['search_filtered', 'ozon_search', { query: 'мобильный кондиционер', limit: 2, sort: 'cheaper', maxPriceRub: 30000, brands: ['CENTEK'], deliveryWithinDays: 7 }],
  ['product', 'ozon_product', { url: product }],
  ['media', 'ozon_product_media', { url: product, limit: 30 }],
  ['reviews_low', 'ozon_reviews', { url: product, sort: 'rating_asc', limit: 3 }],
  ['reviews_high', 'ozon_reviews', { url: product, sort: 'rating_desc', limit: 1 }],
  ['questions', 'ozon_questions', { url: product, limit: 3 }],
  ['orders_active', 'ozon_orders', { status: 'active', limit: 10 }],
  ['orders_completed', 'ozon_orders', { status: 'completed', limit: 3 }],
  ['collections', 'ozon_collections', {}],
  ['cart', 'ozon_cart', {}],
  ['checkout_preview', 'ozon_checkout_prepare', { url: product, quantity: 1 }]
];
const wanted = new Set(process.argv.slice(2));
const dir = path.join(stateDir(), 'dev/acceptance'); await privateDir(dir);
const client = new Client({ name: 'ozon-readonly-acceptance', version: '2' });
const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'serve'], stderr: 'pipe' });
await client.connect(transport);
try {
  for (const [name, tool, args] of cases.filter(([name]) => !wanted.size || wanted.has(name))) {
    const started = performance.now(); console.log(JSON.stringify({ case: name, phase: 'started' }));
    try {
      const response = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 610000 });
      const data = response.structuredContent ?? response;
      await fs.writeFile(path.join(dir, name + '.json'), JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ case: name, phase: 'finished', error: !!response.isError, status: data.status ?? null,
        items: data.items?.length ?? data.media?.length ?? data.groups?.length ?? null, missingCount: data.coverage?.missing?.length ?? data.missing?.length ?? 0,
        elapsedMs: Math.round(performance.now() - started) }));
    } catch (error) { console.log(JSON.stringify({ case: name, phase: 'failed', type: error.name, elapsedMs: Math.round(performance.now() - started) })); }
  }
} finally { await client.close(); }
