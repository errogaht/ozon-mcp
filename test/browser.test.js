import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readCardsInPage, cardEvidence } from '../src/snapshot.js';

test('Semantic card extraction ignores generated CSS classes and neighboring prices', async () => {
  // The same SKU's image/title links share one card; two adjacent SKUs must never
  // borrow prices from their common ancestor. This fixture contains no real account data.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<main><div class="randomA"><a href="https://www.ozon.ru/product/conditioner-123/"><span>Распродажа</span></a><div><span>27 990 ₽</span><del>35 000 ₽</del><a href="https://www.ozon.ru/product/conditioner-123/">Компрессорный кондиционер</a></div></div><div class="unrelatedHash"><span>990 ₽</span><a href="https://www.ozon.ru/product/mini-cooler-456/">Мини охладитель USB</a></div><div style="display:none"><span>1 ₽</span><a href="https://www.ozon.ru/product/hidden-789/">Скрытая карточка</a></div><div><a href="https://www.ozon.ru/product/priceless-999/">Без указанной цены</a></div></main>`);
    const cards = await page.evaluate(readCardsInPage); const first = cards.find(p => p.sku === '123'); const second = cards.find(p => p.sku === '456');
    assert.equal(first.title, 'Компрессорный кондиционер');
    assert.equal(cardEvidence(first, 'p1', 'https://www.ozon.ru/search/').priceRub, 27990);
    assert.equal(cardEvidence(second, 'p2', 'https://www.ozon.ru/search/').priceRub, 990);
    assert.ok(!cards.some(p => ['789', '999'].includes(p.sku)));
  } finally { await browser.close(); }
});
