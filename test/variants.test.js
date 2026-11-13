import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BrowserAdapter } from '../src/adapter.js';
import { discoverVariants, selectReviewScope } from '../src/variants.js';
import { consumerInputs } from '../src/contracts.js';
import { ConsumerOperations } from '../src/operations.js';
import { loadSettings } from '../src/config.js';

test('Review scope is explicitly selected and cannot be inferred from label presence', async () => {
  // A whole-group list is unsafe by default. Only the native selected radio
  // proves current-variant scope; a decorative label must remain unverified.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<label><input type="radio" name="scope" checked>Все варианты</label><label><input type="radio" name="scope">Этот вариант</label>');
    const adapter = { page };
    assert.equal((await selectReviewScope(adapter, 'current')).verified, true);
    assert.equal(await page.locator('input').nth(1).isChecked(), true);
    assert.equal((await selectReviewScope(adapter, 'all')).verified, true);
    await page.setContent('<span>Этот вариант</span>');
    assert.equal((await selectReviewScope(adapter, 'current')).verified, false);
    await page.setContent('<span>Нет фильтра</span>');
    assert.equal((await selectReviewScope(adapter, 'current')).verified, false);
  } finally { await browser.close(); }
});

test('Variant choices must belong to their claimed group and use observed product URLs', async () => {
  // A recommendation with the same label is not an option of the size selector.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage(); await page.route('**/*', r => r.fulfill({ contentType:'text/html; charset=utf-8', body: '<section role="group" aria-label="Мощность"><h2>Мощность</h2><a href="https://www.ozon.ru/product/p-123/">900 Вт</a><a href="https://www.ozon.ru/product/p-456/">1200 Вт</a></section><a href="https://www.ozon.ru/product/p-789/">Рекомендация</a>' }));
    await page.goto('https://www.ozon.ru/product/p-123/');
    const adapter = new BrowserAdapter(page, { kind: 'product', scope: 'catalog', mode: 'read' }, await loadSettings()); await adapter.observe({ viewportOnly: false });
    const nodes = [...adapter.current.nodes.values()]; const source = (role, name) => nodes.find(n => n.role === role && n.name === name).source;
    const operations = { async adapt() { return { data: { groups: [{ label: 'Мощность', sourceRef: source('group','Мощность'), options: [{ label: '900 Вт', sourceRef: source('link','900 Вт') },{ label: '1200 Вт', sourceRef: source('link','1200 Вт') },{ label:'Рекомендация',sourceRef:source('link','Рекомендация') }] }], missing: [] }, meta: {} }; } };
    const data = await discoverVariants(operations, adapter, await loadSettings());
    assert.deepEqual(data.groups[0].options.map(x => x.sku), ['123','456']);
    assert.equal(consumerInputs.reviews.parse({url:'https://www.ozon.ru/product/p-123/'}).scope, 'current');
    const real = new ConsumerOperations({}); real.readCursor = async () => ({sort:'useful',reviewScope:'all'});
    await assert.rejects(real.list('reviews',{url:page.url(),cursor:'fixture',scope:'current'},await loadSettings()),e=>e.code==='invalid_cursor');
  } finally { await browser.close(); }
});


test('Counted custom chips use fresh visual proof and cannot silently toggle unknown state', async () => {
  // Ozon also renders a focusable chip without ARIA state. A bounded visual
  // verifier must establish both initial and resulting state; no blind toggle.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div tabindex="0" style="background:white" onclick="this.style.background=this.style.background==='white'?'blue':'white'"><span>Этот вариант товара (12)</span></div>`);
    const adapter = { page, task: {} }; let reads=0;
    const verifyVisual = async () => { reads++; return page.locator('[tabindex]').evaluate(el=>el.style.background==='blue'); };
    assert.equal((await selectReviewScope(adapter,'current',{verifyVisual})).verified,true);
    assert.equal(reads,2);
    assert.equal((await selectReviewScope(adapter,'current',{verifyVisual})).count,12);
    assert.equal((await selectReviewScope(adapter,'all',{verifyVisual})).verified,true);
    assert.equal(await page.locator('[tabindex]').evaluate(el=>el.style.background),'white');
    assert.equal((await selectReviewScope({page,task:{}},'current')).verified,false);
    await page.setContent('<button>Все варианты</button><button>Этот вариант</button>');
    assert.equal((await selectReviewScope({page,task:{}},'all',{apply:false,verifyVisual:async()=>false})).verified,true);
  } finally { await browser.close(); }
});
