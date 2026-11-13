import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogURL, inferredBudget, productId, searchURL, selectEvidence, cleanPageText } from '../src/policy.js';
import { cardEvidence, compactTree } from '../src/snapshot.js';

test('Only consumer catalog pages are navigable, including when a malicious title supplies a URL', () => {
  // Page content must never turn a research request into an account/cart/API call.
  for (const url of ['https://evil.example/product/123/', 'https://ozon.ru.evil.test/product/123/', 'https://www.ozon.ru/cart', 'https://www.ozon.ru/my/main', 'https://www.ozon.ru/api/composer-api.bx/page/json/v2', 'https://www.ozon.ru:444/product/a-123/', 'https://name:password@www.ozon.ru/product/a-123/', 'http://www.ozon.ru/product/a-123/', 'https://www.ozon.ru/search/?action=buy']) {
    assert.throws(() => catalogURL(url));
  }
  assert.equal(catalogURL('https://ozon.ru/product/appliance-123/?at=tracking#review', true), 'https://www.ozon.ru/product/appliance-123/');
  assert.equal(productId('https://www.ozon.ru/product/appliance-123/'), '123');
  assert.throws(() => catalogURL('https://www.ozon.ru/product/item-123%2f..%2fcart/', true));
  // Ozon redirects generic searches to a predicted category using view-only flags.
  assert.ok(catalogURL('https://www.ozon.ru/category/appliances-123/?category_was_predicted=true&deny_category_prediction=true&text=conditioner').includes('category_was_predicted'));
});

test('Russian budget expressions stay distinct from the search phrase', () => {
  // Cover the owner example and abbreviated budgets; do not infer a budget from a model number.
  assert.equal(inferredBudget('мобильные кондиционеры до 30000 руб'), 30000);
  assert.equal(inferredBudget('не дороже 30 000 ₽'), 30000);
  assert.equal(inferredBudget('до 30 тыс. руб'), 30000);
  assert.equal(inferredBudget('до 29,5 тыс рублей'), 29500);
  assert.equal(inferredBudget('кондиционер 12000 BTU'), null);
  const url = new URL(searchURL('мобильный кондиционер', 30000));
  assert.equal(url.searchParams.get('text'), 'мобильный кондиционер');
  assert.equal(url.searchParams.get('price'), '0.000;30000.000');
});

test('Final results cannot invent an SKU or slip an unpriced/over-budget card into a budget search', () => {
  // The model chooses evidence IDs only; all customer-facing product facts come from the ledger.
  const ledger = new Map([
    ['p1', { sku: '100', priceRub: 29999, title: 'Observed', url: 'https://www.ozon.ru/product/a-100/' }],
    ['p2', { sku: '101', priceRub: 31000 }], ['p3', { sku: '102', priceRub: null }],
    ['p4', { sku: '100', priceRub: 29999 }]
  ]);
  const result = selectEvidence(ledger, ['p1', 'p2', 'p3', 'p4', 'p99'], 30000, 5);
  assert.equal(result.products.length, 1); assert.equal(result.products[0].title, 'Observed');
  assert.deepEqual(result.rejected.map(i => i.reason), ['budget_not_verified', 'budget_not_verified', 'not_observed']);
});

test('Rendered prices keep their displayed conditions and remove link tracking', () => {
  // Preserve the cheaper conditional price and the older price separately; do not promise checkout totals.
  const result = cardEvidence({ url: 'https://www.ozon.ru/product/air-conditioner-123/?at=abc', title: 'Кондиционер', cardText: '27\u2009990 ₽\nс Ozon Картой\n35\u00a0000 ₽\nКондиционер' }, 'p1', 'https://www.ozon.ru/search/');
  assert.equal(result.priceRub, 27990); assert.equal(result.priceBasis, 'ozon_card');
  assert.equal(result.observedPrices[1].rub, 35000); assert.equal(result.url, 'https://www.ozon.ru/product/air-conditioner-123/');
  // A model year on the previous line must not become part of the price.
  assert.equal(cardEvidence({ url: result.url, title: 'Модель 2026', cardText: 'Модель 2026\n27 990 ₽' }, 'p2', result.sourceUrl).priceRub, 27990);
});

test('Compact YAML removes private header, wrappers and advertising destinations', () => {
  // A logged-in header may contain the owner name/address; never forward it with catalog data.
  const raw = '- generic [ref=e1]:\n  - banner [ref=e2]:\n    - text: PRIVATE ACCOUNT\n  - generic [ref=e3]:\n    - heading "Каталог" [level=1]\n    - link "Кондиционер" [ref=e4] [cursor=pointer]:\n      - /url: /product/air-123/?at=tracking\n    - link "Реклама":\n      - /url: https://evil.example/?token=123\n';
  const result = compactTree(raw, 4000);
  assert.ok(!result.yaml.includes('PRIVATE')); assert.ok(!result.yaml.includes('ref='));
  assert.ok(!result.yaml.includes('tracking')); assert.ok(!result.yaml.includes('evil.example'));
  assert.ok(result.yaml.includes('air-123')); assert.ok(result.yaml.includes('Кондиционер'));
  assert.ok(compactTree('- text: ' + 'x'.repeat(10000), 1500).chars <= 1500);
});

test('Credential-like page text is redacted before it can enter model context', () => {
  // Defense in depth for a hostile page echoing tokens as ordinary text.
  assert.ok(!cleanPageText('sk-clb-abcdefghijklmnopqrstuvwxyz').includes('abcdefghijklmnopqrstuvwxyz'));
  assert.equal(cleanPageText('до\u202e30000'), 'до30000');
});
