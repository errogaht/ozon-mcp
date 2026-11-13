import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { listEvidenceErrors, reviewSortMatches, galleryThumbnails, listEntityCandidates } from '../src/evidence.js';
import { BrowserAdapter } from '../src/adapter.js';
import { loadSettings } from '../src/config.js';

test('Question body, author and every answer must belong to that exact entity', () => {
  // Regression: Luna reused the next question's textRef and paired it with
  // the previous answer. Plausible-looking but unrelated text must be rejected.
  const source = new Map([
    ['s1:e1', 'Иван 1 ноября Какой хладагент? Продавец 2 ноября R410A'],
    ['s1:e2', 'Какой хладагент?'], ['s1:e3', 'Продавец 2 ноября R410A'], ['s1:e4', 'R410A'],
    ['s1:e5', 'Нужно ли заливать воду?'], ['s1:e6', 'Другой продавец 3 ноября Не нужно']
  ]);
  const row = { sourceRef: 's1:e1', author: 'Иван', date: '1 ноября', textRef: 's1:e2', answers: [{ sourceRef: 's1:e3', textRef: 's1:e4', author: 'Продавец', date: '2 ноября' }] };
  const check = rows => listEvidenceErrors('questions', rows, ref => source.get(ref));
  assert.deepEqual(check([row]), []);
  assert.ok(check([{ ...row, textRef: 's1:e5' }]).length);
  assert.ok(check([{ ...row, author: 'Петр' }]).length);
  assert.ok(check([{ ...row, answers: [{ ...row.answers[0], sourceRef: 's1:e6' }] }]).length);
  assert.ok(check([row, row]).some(error => /duplicates/.test(error)));
});

test('Star-only reviews remain separate entities alongside written reviews', async () => {
  // Empty review bodies still contribute a rating and must not disappear from
  // pagination merely because Ozon omits their helpfulness toolbar.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://www.ozon.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<main><article><div>Иван</div><div>1 ноября 2026</div><p>Хорошо охлаждает</p><div>Вам помог этот отзыв?</div></article><article><div>Петр</div><div>2 ноября 2026</div><a>Вариант белый</a></article></main>' }));
    await page.goto('https://www.ozon.ru/product/fixture-123/reviews/');
    const adapter = new BrowserAdapter(page, { kind: 'reviews', scope: 'catalog', mode: 'read' }, await loadSettings()); await adapter.observe({ viewportOnly: false });
    const rows = listEntityCandidates(adapter, 'reviews'); assert.equal(rows.length, 2);
    assert.ok(rows.some(row => row.text.includes('Петр') && !row.text.includes('Иван')));
  } finally { await browser.close(); }
});

test('Review low/high and strict newest ordering cannot be interchanged', () => {
  // Ozon's combined new/useful option does not promise strict date ordering.
  assert.equal(reviewSortMatches('с низкой оценкой', 'rating_asc'), true);
  assert.equal(reviewSortMatches('с высокой оценкой', 'rating_asc'), false);
  assert.equal(reviewSortMatches('с высокой оценкой', 'rating_desc'), true);
  assert.equal(reviewSortMatches('новые и полезные', 'new'), false);
  assert.equal(reviewSortMatches('новые и полезные', 'useful'), true);
  assert.equal(reviewSortMatches('Сначала новые', 'new'), true);
});

test('Gallery enumerates background and image thumbnails without including the large main image', async () => {
  // Generated class names and missing accessible names are intentional. The
  // bounded media-only root, actual sources and display size identify thumbs.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  try {
    const page = await browser.newPage();
    // Image URLs model CDN identities only; unit fixtures must not contact it.
    await page.route('https://**/*', route => route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo0AAAAASUVORK5CYII=', 'base64') }));
    await page.setContent('<main><img style="width:500px;height:700px" src="https://ir.ozone.ru/wc2500/a.jpg"><span style="display:inline-block;width:50px;height:60px;background-image:url(https://ir.ozone.ru/wc100/a.jpg)"></span><img style="width:50px;height:60px" src="https://ir.ozone.ru/wc100/b.jpg"></main>');
    const thumbs = await page.locator('main').evaluate(galleryThumbnails);
    assert.equal(thumbs.length, 2); assert.ok(thumbs.every(item => item.source.includes('wc100')));
  } finally { await browser.close(); }
});
