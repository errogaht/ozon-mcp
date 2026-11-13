import test from 'node:test';
import assert from 'node:assert/strict';
import { runSearch } from '../src/agent.js';
import { loadSettings, AppError, publicError } from '../src/config.js';
import { serialQueue } from '../src/service.js';

const tool = (name, args, n) => ({ output: [{ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args) }], usage: { input_tokens: 10, output_tokens: 3 } });
const product = { evidenceId: 'p1', sku: '123', title: 'Реальный мобильный кондиционер', priceRub: 27990, url: 'https://www.ozon.ru/product/air-123/' };
const fakeBrowser = () => ({ ledger: new Map(), async beginRun() {}, async search(query, budget) { this.ledger.set('p1', product); return { products: [product], budget }; } });

test('A real tool-call loop honors the owner budget and returns browser facts', async () => {
  // A natural-language budget is enforced even if the model omits it in its action.
  const cfg = await loadSettings(); const browser = fakeBrowser(); let i = 0;
  const responses = [tool('search_catalog', { query: 'мобильный кондиционер', maxPriceRub: null, sort: 'relevance' }, 1), tool('finish', { evidenceIds: ['p1'], status: 'complete', note: '' }, 2)];
  const result = await runSearch(browser, { query: 'мобильные кондиционеры до 30000 руб', limit: 1 }, cfg, { client: {}, respond: async (_client, request) => { assert.equal(request.model, cfg.models.browserAgent.model); assert.equal(request.reasoning.effort, cfg.models.browserAgent.reasoningEffort); return responses[i++]; } });
  assert.equal(result.status, 'complete'); assert.equal(result.maxPriceRub, 30000); assert.equal(result.products[0].priceRub, 27990); assert.equal(result.agent.steps, 2);
});

test('Invalid invented evidence is returned to the model for correction rather than published', async () => {
  // A hallucinated cheap offer cannot escape merely by appearing in finish arguments.
  const cfg = await loadSettings(); let i = 0;
  const responses = [tool('search_catalog', { query: 'кондиционер', maxPriceRub: null, sort: 'relevance' }, 1), tool('finish', { evidenceIds: ['p999'], status: 'complete', note: '' }, 2), tool('finish', { evidenceIds: ['p1'], status: 'complete', note: '' }, 3)];
  const result = await runSearch(fakeBrowser(), { query: 'кондиционер', limit: 1 }, cfg, { client: {}, respond: async (_c, req) => { if (i === 2) assert.ok(req.input.at(-1).output.includes('not_observed')); return responses[i++]; } });
  assert.equal(result.products[0].sku, '123'); assert.equal(result.agent.steps, 3);
});

test('Blocked Ozon is a hard error, not a successful empty search', async () => {
  // A VPN/challenge page must be surfaced to the owner instead of relabeling it as no stock.
  const browser = fakeBrowser(); browser.search = async () => { throw new AppError('site_blocked', 'Ozon ограничил доступ.'); };
  await assert.rejects(runSearch(browser, { query: 'кондиционер' }, await loadSettings(), { client: {}, respond: async () => tool('search_catalog', { query: 'кондиционер', maxPriceRub: null, sort: 'relevance' }, 1) }), error => error.code === 'site_blocked');
});

test('Step limits stop paid agent loops without fabricating success', async () => {
  // A model repeatedly searching cannot spend unbounded calls.
  const cfg = await loadSettings(); cfg.agent.maxSteps = 2;
  await assert.rejects(runSearch(fakeBrowser(), { query: 'кондиционер' }, cfg, { client: {}, respond: async () => tool('search_catalog', { query: 'кондиционер', maxPriceRub: null, sort: 'relevance' }, 1) }), error => error.code === 'step_limit');
});

test('The service queue serializes entire operations and recovers from a failed request', async () => {
  // Two concurrent clients must not observe each other's browser state, even when one fails.
  const queue = serialQueue(); const order = [];
  const first = queue(async () => { order.push('first-start'); await new Promise(r => setTimeout(r, 5)); order.push('first-end'); throw new Error('expected'); });
  const second = queue(async () => { order.push('second'); return 42; });
  await assert.rejects(first); assert.equal(await second, 42);
  assert.deepEqual(order, ['first-start', 'first-end', 'second']);
});

test('Unknown provider errors never expose secrets in MCP responses', () => {
  // Real SDK errors can include authorization headers; only known error codes/messages cross the boundary.
  const error = new Error('Authorization: Bearer sk-clb-secret-value'); error.status = 401;
  assert.ok(!JSON.stringify(publicError(error)).includes('sk-clb'));
});
