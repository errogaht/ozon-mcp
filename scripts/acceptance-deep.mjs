import fs from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { stateDir, writePrivateJSON } from '../src/config.js';

/** Follow only previously observed read-only IDs/links/cursors. This script
 * has no mutation/final case and never prints account data or binary images. */
const dir = path.join(stateDir(), 'dev/acceptance');
const read = async name => JSON.parse(await fs.readFile(path.join(dir, name + '.json'), 'utf8'));
const questions = await read('questions'); const reviews = await read('reviews_low'); const orders = await read('orders_completed');
const cases = [];
if (questions.nextCursor) cases.push(['questions_next', 'ozon_questions', { url: questions.url, cursor: questions.nextCursor, limit: 3 }, questions.items]);
if (reviews.nextCursor) cases.push(['reviews_next', 'ozon_reviews', { url: reviews.url, cursor: reviews.nextCursor, sort: 'rating_asc', limit: 3 }, reviews.items]);
if (reviews.items?.[0]) cases.push(['review_media', 'ozon_review_media', { reviewId: reviews.items[0].id, limit: 20 }]);
const withVideo = reviews.items?.find(item => item.media?.some(media => /\/video-\d+\//.test(media.url)));
if (withVideo) cases.push(['review_video', 'ozon_review_media', { reviewId: withVideo.id, limit: 20 }]);
const order = orders.items?.find(item => item.detailUrl);
if (order) cases.push(['order_detail', 'ozon_order_detail', { url: order.detailUrl }]);
const selected = new Set(process.argv.slice(2));
const c = new Client({ name: 'ozon-deep-readonly-acceptance', version: '2' });
await c.connect(new StdioClientTransport({ command: process.execPath, args: ['src/cli.js', 'serve'], stderr: 'pipe' }));
try {
  for (const [name, tool, args, prior] of cases.filter(([name]) => !selected.size || selected.has(name))) {
    const start = Date.now(); console.log(JSON.stringify({ case: name, phase: 'started' }));
    const result = await c.callTool({ name: tool, arguments: args }, undefined, { timeout: 610000 });
    const data = result.structuredContent ?? result; await writePrivateJSON(path.join(dir, name + '.json'), data);
    const ids = new Set(prior?.map(item => item.id) ?? []);
    console.log(JSON.stringify({ case: name, phase: 'finished', error: !!result.isError, items: data.items?.length ?? data.media?.length,
      duplicatePriorEntities: data.items?.filter(item => ids.has(item.id)).length ?? 0, missingCount: data.coverage?.missing?.length ?? 0,
      complete: data.coverage?.complete ?? null, elapsedMs: Date.now() - start }));
  }
} finally { await c.close(); }
