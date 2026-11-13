import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { ConsumerWorkflows } from '../src/workflows.js';
import { ConfirmationStore } from '../src/confirmation.js';
import { loadSettings } from '../src/config.js';

test('Checkout preparation binds real quantity, arrival date and literal financing terms without a final click', async () => {
  // Entirely synthetic checkout. The owner never authorizes real purchases in
  // test runs; the dangerous button records an accidental submission locally.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ozon-prepare-'));
  try {
    const page = await browser.newPage(); let shownQuantity = 1; let couponEnabled = false;
    await page.route('https://www.ozon.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: route.request().url().includes('gocheckout')
      ? `<article><h2>Fixture product</h2><p>${shownQuantity} шт</p></article><p>Итого 99 ₽</p><section>Ozon Рассрочка<p>Льготный период, 0 ₽ сегодня, 20 ₽ × 6 мес</p></section><p>Пункт Ozon: улица Тестовая, 70. Срок хранения заказа — 14 дней</p><p>Доставка завтра</p><button onclick="window.submitted=true">Оформить заказ</button>`
      : `<h1>Fixture product</h1>${couponEnabled?'<section><p>99 ₽</p><div><button>Скидка по купону</button><p>Применён</p></div></section>':''}<button onclick="location.href='/gocheckout'">Купить сейчас</button>` }));
    const workflows = new ConsumerWorkflows({ async connect() {}, async beginRun() { return page; } });
    workflows.ownerHash = async () => 'fixture-owner'; workflows.confirmations = new ConfirmationStore(root);
    const cfg = await loadSettings();
    workflows.adapt = async adapter => {
      await adapter.observe({ viewportOnly: false });
      const buy = [...adapter.current.nodes.values()].find(node => node.name === 'Купить сейчас');
      await adapter.act('browser_click', { sourceRef: buy.source, purpose: 'Synthetic exact-SKU Buy now' });
      await adapter.observe({ viewportOnly: false });
      const ref = text => [...adapter.current.nodes.values()].filter(node => node.text === text || node.name === text).sort((a, b) => a.text.length - b.text.length)[0]?.source;
      const data = { items: [{ title: 'Fixture product', sku: '123', quantity: 1, quantitySourceRef: ref(shownQuantity + ' шт'), priceRub: 99, sourceRef: ref('Fixture product\n' + shownQuantity + ' шт') }],
        totalRub: 99, totalSourceRef: ref('Итого 99 ₽'), paymentLabel: 'Variable model prose', paymentSourceRef: ref('Ozon Рассрочка\nЛьготный период, 0 ₽ сегодня, 20 ₽ × 6 мес'),
        delivery: { method: 'pickup', label: 'Variable date paraphrase', earliestDate: null, latestDate: null, pickupPoint: 'Тестовая, 70', sourceRef: null,
          dateSourceRef: ref('Доставка завтра'), pickupSourceRef: ref('Пункт Ozon: улица Тестовая, 70. Срок хранения заказа — 14 дней') },
        finalButtonRef: ref('Оформить заказ'), additionalCharges: [], additionalChargeRefs: [], missing: [] };
      return { data, meta: {} };
    };
    const args = { url: 'https://www.ozon.ru/product/fixture-123/', quantity: 1, pickupPoint: 'Тестовая, 70', payment: 'ozon_installment' };
    const first = await workflows.prepareAction('checkout', args, cfg);
    assert.equal(first.status, 'prepared'); assert.equal(first.preview.items[0].quantity, 1);
    assert.ok(first.preview.paymentTerms.includes('20 ₽ × 6 мес'));
    assert.notEqual(first.preview.delivery.latestDate, null);
    const second = await workflows.prepareAction('checkout', args, cfg);
    assert.equal(second.confirmation.digest, first.confirmation.digest);
    const capped = await workflows.prepareAction('checkout', { ...args, maxTotalRub: 98 }, cfg);
    assert.equal(capped.status, 'prepare_incomplete'); assert.ok(capped.missing.some(message => message.includes('maxTotalRub')));
    assert.equal(workflows.pickupMatches('Тестовая, 70', 'улица Тестовая, 701'), false);
    assert.equal(workflows.pickupMatches('Тестовая, 70', 'улица Тестовая, 70А'), false);
    shownQuantity = 2;
    const changed = await workflows.prepareAction('checkout', args, cfg);
    assert.equal(changed.status, 'prepare_incomplete');
    assert.ok(changed.missing.some(message => /Количество позиции/.test(message)));
    // A late/new coupon cannot reuse an older no-coupon token, and a higher
    // total must be blocked even when the model returns an otherwise valid form.
    shownQuantity = 1; couponEnabled = true;
    workflows.priceForProduct = async () => ({coupon:{priceRub:90}});
    const undiscounted = await workflows.prepareAction('checkout',args,cfg);
    assert.equal(undiscounted.status,'prepare_incomplete');
    assert.ok(undiscounted.missing.some(message=>/купон/iu.test(message)));
    assert.equal(undiscounted.confirmation,undefined);
    workflows.priceForProduct = async () => ({coupon:{priceRub:99}});
    await assert.rejects(workflows.confirmAction({confirmation:{...first.confirmation,confirmed:true}},cfg),error=>error.code==='preview_changed');
    assert.equal(await page.evaluate(() => window.submitted ?? false), false);
  } finally { await browser.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Collection commit is blocked until actual name/visibility/cover match requested private settings', async () => {
  // A model result claiming readiness cannot publish a collection while the
  // native checkbox is public or the assigned cover was never uploaded.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage(); let isPublic = true;
    await page.route('https://www.ozon.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<label>Название<input value="Fixture collection"></label><textarea>Fixture description</textarea><input type="checkbox" ${isPublic ? 'checked' : ''}><button onclick="window.saved=1;document.body.innerText='Подборка создана: Fixture collection'">Создать подборку</button>` }));
    const workflows = new ConsumerWorkflows({ async beginRun() { return page; } });
    workflows.adapt = async adapter => {
      await adapter.observe({ viewportOnly: false }); const nodes = [...adapter.current.nodes.values()];
      return { data: { nameRef: nodes.find(n => n.role === 'textbox' && n.name === 'Название').source,
        descriptionRef: nodes.find(n => n.role === 'textbox' && n.name !== 'Название').source, visibilityRef: nodes.find(n => n.role === 'checkbox').source,
        saveButtonRef: nodes.find(n => n.name === 'Создать подборку').source, missing: [] }, meta: {} };
    };
    const cfg = await loadSettings(); const args = { name: 'Fixture collection', description: 'Fixture description', isPublic: false, productUrls: [], apply: true };
    const unsafe = await workflows.createCollection(args, cfg); assert.equal(unsafe.status, 'prepare_incomplete'); assert.equal(await page.evaluate(() => window.saved ?? 0), 0);
    isPublic = false;
    const noCover = await workflows.createCollection({ ...args, coverMediaId: 'fixture-not-uploaded' }, cfg); assert.equal(noCover.status, 'prepare_incomplete'); assert.equal(await page.evaluate(() => window.saved ?? 0), 0);
    const safe = await workflows.createCollection(args, cfg); assert.equal(safe.status, 'applied'); assert.equal(await page.evaluate(() => window.saved), 1);
  } finally { await browser.close(); }
});

test('Review preparation requires the selected rating, not the text of an unchecked star', async () => {
  // A misleading model may cite the five-star option without selecting it.
  // That must never issue a publish token, even with correct text/order/title.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ozon-review-'));
  try {
    const page = await browser.newPage(); let checked = false;
    await page.route('https://www.ozon.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<p>Заказ № 100-1</p><h2>Fixture product</h2><input type="radio" aria-label="5 звёзд" value="5" ${checked ? 'checked' : ''}><textarea>Owner experience</textarea><button onclick="window.posted=true">Опубликовать отзыв</button>` }));
    const workflows = new ConsumerWorkflows({ async beginRun() { return page; } }); workflows.ownerHash = async () => 'fixture'; workflows.confirmations = new ConfirmationStore(root);
    workflows.adapt = async adapter => {
      await adapter.observe({ viewportOnly: false }); const nodes = [...adapter.current.nodes.values()];
      return { data: { target: 'Fixture product', summary: 'Fixture summary', identityRef: nodes.find(n => n.role === 'heading').source,
        orderRef: nodes.find(n => n.text === 'Заказ № 100-1').source, selectedItems: [], termsRefs: [],
        fields: [{ name: 'Оценка', sourceRef: nodes.find(n => n.role === 'radio').source }, { name: 'Текст', sourceRef: nodes.find(n => n.role === 'textbox').source }],
        finalButtonRef: nodes.find(n => n.name === 'Опубликовать отзыв').source, missing: [] }, meta: {} };
    };
    const cfg = await loadSettings(), args = { orderUrl: 'https://www.ozon.ru/my/orderdetails/100-1', productTitle: 'Fixture product', stars: 5, text: 'Owner experience' };
    const invalid = await workflows.prepareAction('review', args, cfg);
    assert.equal(invalid.status, 'prepare_incomplete'); assert.ok(invalid.missing.some(message => /выбранный контрол оценки/.test(message)));
    checked = true; const valid = await workflows.prepareAction('review', args, cfg); assert.equal(valid.status, 'prepared');
    assert.equal(await page.evaluate(() => window.posted ?? false), false);
  } finally { await browser.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('Return preview binds the selected item, truthful reason, quantity and refund terms without submission', async () => {
  // Fictional order and defect, isolated browser context: no real customer's
  // order or return eligibility is touched by this positive/negative fixture.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ozon-return-'));
  try {
    const page = await browser.newPage(); let actualQuantity = 1;
    await page.route('https://www.ozon.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<p>Заказ № 100-1</p><article><h2>Fixture product</h2><input type="checkbox" aria-label="Fixture product" checked><p>${actualQuantity} шт</p></article><input type="radio" aria-label="Товар поврежден" value="damaged" checked><label>Комментарий<textarea>Owner comment</textarea></label><p>Возврат 99 ₽ на Ozon Карту</p><button onclick="window.returnSent=true">Оформить возврат</button>` }));
    const workflows = new ConsumerWorkflows({ async beginRun() { return page; } }); workflows.ownerHash = async () => 'fixture'; workflows.confirmations = new ConfirmationStore(root);
    workflows.adapt = async adapter => {
      await adapter.observe({ viewportOnly: false }); const nodes = [...adapter.current.nodes.values()];
      return { data: { target: 'Fixture product', summary: 'Fixture return', identityRef: nodes.find(n => n.role === 'heading').source,
        orderRef: nodes.find(n => n.text === 'Заказ № 100-1').source,
        selectedItems: [{ productTitle: 'Fixture product', quantity: 1, sourceRef: nodes.find(n => n.role === 'article').source, checkedRef: nodes.find(n => n.role === 'checkbox').source, quantityRef: nodes.find(n => n.text === actualQuantity + ' шт').source }],
        termsRefs: [nodes.find(n => n.text === 'Возврат 99 ₽ на Ozon Карту').source],
        fields: [{ name: 'Причина', sourceRef: nodes.find(n => n.role === 'radio').source }, { name: 'Комментарий', sourceRef: nodes.find(n => n.role === 'textbox').source }],
        finalButtonRef: nodes.find(n => n.name === 'Оформить возврат').source, missing: [] }, meta: {} };
    };
    const cfg = await loadSettings(), args = { orderUrl: 'https://www.ozon.ru/my/orderdetails/100-1', productTitle: 'Fixture product', quantity: 1, reason: 'Товар поврежден', comment: 'Owner comment' };
    const valid = await workflows.prepareAction('return', args, cfg); assert.equal(valid.status, 'prepared'); assert.ok(valid.preview.terms[0].includes('99 ₽'));
    actualQuantity = 2; const wrongCount = await workflows.prepareAction('return', args, cfg); assert.equal(wrongCount.status, 'prepare_incomplete');
    actualQuantity = 1; const wrongReason = await workflows.prepareAction('return', { ...args, reason: 'Передумал' }, cfg); assert.equal(wrongReason.status, 'prepare_incomplete');
    assert.ok(wrongReason.availableChoices.some(choice => choice.label === 'Товар поврежден'));
    assert.equal(await page.evaluate(() => window.returnSent ?? false), false);
  } finally { await browser.close(); await fs.rm(root, { recursive: true, force: true }); }
});
