import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BrowserAdapter } from '../src/adapter.js';
import { loadSettings } from '../src/config.js';

test('Adapter refs preserve full historical text, omit account header and block a live final-button fixture', async () => {
  // A real browser fixture exercises refs/hit testing without accessing Ozon or
  // a real order. If policy regresses, the fixture records the unwanted click.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage(); await page.route('https://www.ozon.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<header>PRIVATE ACCOUNT</header><main><h1>Product</h1><a href="/product/fixture-456/?track=ignored">Other product</a><article><h2>Описание</h2><p>Полный длинный текст без пересказа</p></article><button onclick="document.body.dataset.submitted=1">Оформить заказ</button><button onclick="document.body.dataset.sent=1">Отправить</button></main>' }));
    await page.goto('https://www.ozon.ru/product/fixture-123/');
    const adapter = new BrowserAdapter(page, { kind: 'checkout', scope: 'checkout', mode: 'prepare' }, await loadSettings());
    const first = await adapter.observe({ viewportOnly: false });
    assert.ok(!first.tree.includes('PRIVATE ACCOUNT')); assert.ok(first.tree.includes('Описание'));
    assert.ok(first.tree.includes('[url=https://www.ozon.ru/product/fixture-456/]'));
    const section = await adapter.observe({ search: 'Описание', viewportOnly: false });
    assert.ok(section.matches.some(match => match.contextTree.includes('Полный длинный текст')));
    // Subsequent actions deliberately use the fresh full source handle.
    const activeSnapshot = section.snapshotId;
    const source = [...adapter.current.nodes.values()].find(n => n.text === 'Полный длинный текст без пересказа');
    assert.ok(source);
    const final = [...adapter.current.nodes.entries()].find(([, n]) => n.name === 'Оформить заказ');
    await assert.rejects(adapter.act('browser_click', { sourceRef: activeSnapshot + ':' + final[0], purpose: 'finish' }), e => e.code === 'confirmation_required');
    assert.equal(await page.locator('body').getAttribute('data-submitted'), null);
    await page.locator('p').evaluate(el => { el.textContent = 'Новый текст того же DOM узла'; });
    await adapter.observe({ viewportOnly: false });
    assert.equal(adapter.evidence(source.source).text, 'Полный длинный текст без пересказа');
    await assert.rejects(adapter.act('browser_click', { sourceRef: first.snapshotId + ':' + final[0], purpose: 'retry' }), e => e.code === 'stale_ref');
  } finally { await browser.close(); }
});

test('Isolated entity snapshots expose their complete root and cannot read a neighboring question', async () => {
  // Fragment APIs omit neutral containers. e0 must still resolve the exact
  // bound row so author, question and answer are provably one entity.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage(); await page.route('https://www.ozon.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<div id="one"><p>Иван 1 ноября 2026</p><a>Какой хладагент?</a><p>Продавец 2 ноября 2026: R410A</p></div><div>Соседний вопрос Петра</div>' }));
    await page.goto('https://www.ozon.ru/product/fixture-123/questions/');
    const adapter = new BrowserAdapter(page, { kind: 'questions', scope: 'catalog', mode: 'read', regionLocator: page.locator('#one') }, await loadSettings());
    const observed = await adapter.observe({ viewportOnly: false });
    assert.ok(observed.tree.includes('[ref=s1:e0]')); assert.ok(!observed.tree.includes('Петра'));
    const root = await adapter.read('s1', 'e0');
    assert.ok(root.text.includes('Иван')); assert.ok(root.text.includes('R410A')); assert.ok(!root.text.includes('Петра'));
  } finally { await browser.close(); }
});
