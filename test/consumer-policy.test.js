import test from 'node:test';
import assert from 'node:assert/strict';
import { assertClickAllowed, assertFillAllowed, scopedURL, finalButtonAllowed } from '../src/action-policy.js';
import { deliveryDates, deadlineProof } from '../src/delivery.js';
import { visibleCardFacts } from '../src/snapshot.js';
import { validateCardPrice } from '../src/operations.js';
import { mediaURL, bestObservedMedia } from '../src/media.js';

test('Reader/prepare tasks cannot submit, pay, cancel or disguise a final click as navigation', () => {
  // Page injection in a label must not turn a read task into a financial action.
  for (const mode of ['read', 'prepare', 'mutate']) for (const label of ['Оформить заказ', 'Оплатить', 'Отправить', 'Опубликовать', 'Подтвердить возврат', 'Отменить заказ']) {
    assert.throws(() => assertClickAllowed({ name: label, text: label, role: 'button' }, { kind: 'checkout', scope: 'checkout', mode }));
  }
  assert.throws(() => assertClickAllowed({ name: 'Купить сейчас', role: 'button' }, { kind: 'product', scope: 'catalog', mode: 'read' }));
  assert.doesNotThrow(() => assertClickAllowed({ name: 'Купить сейчас', role: 'button' }, { kind: 'checkout', scope: 'checkout', mode: 'prepare' }));
  assert.throws(() => assertFillAllowed({ name: 'Код из SMS', type: 'text' }, { kind: 'checkout' }));
  assert.throws(() => assertFillAllowed({ name: 'CVV', type: 'text' }, { kind: 'checkout' }));
  assert.equal(finalButtonAllowed('checkout', 'Отправить'), false);
  assert.equal(finalButtonAllowed('checkout', 'Оформить заказ'), true);
  // A gallery reader must not click an unlabeled cart +/- icon outside a modal.
  assert.throws(() => assertClickAllowed({ name: '', text: '', role: 'button', hasMedia: false, inDialog: false }, { kind: 'media', scope: 'catalog', mode: 'read' }));
  assert.throws(() => assertClickAllowed({ name: 'Выбрать товар', role: 'checkbox' }, { kind: 'cart', scope: 'checkout', mode: 'read' }));
  assert.throws(() => assertClickAllowed({ name: 'Создать', text: 'Создать', role: 'button' }, { kind: 'collection_create', scope: 'collections', mode: 'prepare', collectionFormOpen: true }));
  assert.throws(() => assertClickAllowed({ name: 'Создать подборку', role: 'button' }, { kind: 'collection_create', scope: 'collections', mode: 'prepare', collectionFormOpen: true }));
  assert.throws(() => assertClickAllowed({ name: 'Сохранить подборку', role: 'button' }, { kind: 'collection_create', scope: 'collections', mode: 'prepare', collectionFormOpen: true }));
});

test('Account routes are scoped and external/media URLs cannot become SSRF', () => {
  // Reading orders is explicitly allowed; finance/profile/third-party pages are not.
  assert.ok(scopedURL('https://www.ozon.ru/my/orderlist/', 'orders'));
  assert.throws(() => scopedURL('https://www.ozon.ru/cart', 'orders'));
  assert.throws(() => scopedURL('https://www.ozon.ru/my/orderlist/', 'catalog'));
  assert.ok(scopedURL('https://www.ozon.ru/selections/list', 'collections'));
  assert.ok(scopedURL('https://www.ozon.ru/product/appliance-123/features'));
  assert.throws(() => scopedURL('https://www.ozon.ru/my/orderlist/', 'checkout'));
  assert.throws(() => scopedURL('https://www.ozon.ru/selections/list', 'catalog'));
  assert.throws(() => scopedURL('https://evil.test/my/orderlist/', 'orders'));
  assert.throws(() => mediaURL('file:///etc/passwd'));
  assert.throws(() => mediaURL('http://127.0.0.1/secrets'));
  assert.throws(() => mediaURL('https://ozone.ru.evil.test/image.jpg'));
});

test('Ozon Card price requires its own numeric and label/visual evidence, never just the cheapest number', () => {
  // A regular price and monthly installment must not masquerade as card price.
  const fake = text => ({ visualObserved: false, evidence: () => ({ text }) });
  const p = { amount: 27990, sourceRef: 's1:e1', basisLabel: 'Ozon Карта', verifiedOzonCard: true };
  assert.equal(validateCardPrice(p, fake('27 990 ₽ с Ozon Картой')).amount, 27990);
  assert.equal(validateCardPrice(p, fake('27 990 ₽ с другими банками')).amount, null);
  assert.equal(validateCardPrice(p, fake('1 999 ₽ в месяц')).amount, null);
  const visual = fake('27 990 ₽'); visual.visualObserved = true;
  assert.equal(validateCardPrice(p, visual).evidenceType, 'visual');
});

test('Delivery deadlines use Moscow date and the end of an offered range', () => {
  // UTC evening is already the next calendar day in Moscow.
  const now = new Date('2026-11-12T22:00:00Z');
  assert.equal(deliveryDates('Завтра', now).earliest, '2026-11-14');
  assert.equal(deliveryDates('Послезавтра', now).days, 2);
  assert.equal(deliveryDates('16–18 ноября', now).latest, '2026-11-18');
  assert.equal(deliveryDates('16–18 ноября', now).days, 5);
  assert.equal(deliveryDates('Доставка уточняется', now).days, null);
  assert.equal(deliveryDates('до 7 дней', now).days, 7);
  assert.equal(deliveryDates('Доставим с 16 ноября', now).earliest, '2026-11-16');
  assert.equal(deliveryDates('Доставим с 16 ноября', now).days, null);
  assert.equal(deliveryDates('Срок хранения заказа — 14 дней', now).earliest, null);
  assert.equal(deliveryDates('22 ноя – 2 дек', now).latest, '2026-12-02');
  assert.equal(deliveryDates('28 дек – 3 янв', new Date('2026-12-20T10:00:00Z')).latest, '2027-01-03');
  assert.equal(deadlineProof(deliveryDates('С 16 ноября', now), 7, 7, now).matches, true);
  assert.equal(deadlineProof(deliveryDates('С 26 ноября', now), 7, 7, now).matches, false);
  assert.equal(deadlineProof(deliveryDates(null, now), 7, null, now).matches, false);
});

test('Search metadata keeps product and store ratings distinct and copies visible delivery/counts', () => {
  // A shop-only score must never become a 4.9-star product recommendation.
  const product = visibleCardFacts('20 000 ₽\nМобильный кондиционер\n4.8\n12 345 отзывов\n15 вопросов\nДоставим с 16 ноя\n8 ед осталось');
  assert.equal(product.rating, 4.8); assert.equal(product.reviewsCount, 12345); assert.equal(product.questionsCount, 15);
  assert.equal(product.deliveryLabel, 'Доставим с 16 ноя');
  const store = visibleCardFacts('20 000 ₽\n4.9\nРейтинг магазина\nЗавтра');
  assert.equal(store.rating, null); assert.equal(store.storeRating, 4.9);
});

test('Gallery chooses the largest observed asset without inventing an original URL', () => {
  // wc2000 is not requested/returned unless the real gallery actually exposed it.
  const items = [{ url: 'https://ir.ozone.ru/s3/a/wc100/photo.jpg', width: 100 }, { url: 'https://ir.ozone.ru/s3/a/wc1000/photo.jpg', width: 1000 }];
  const selected = bestObservedMedia(items);
  assert.equal(selected.length, 1); assert.equal(selected[0].url, items[1].url); assert.ok(!selected[0].url.includes('wc2000'));
  const streams = bestObservedMedia([{ kind: 'video', url: 'https://vr-1.ozone.ru/sashimi/video-72/ASSET/asset.mp4?fragmented=true' }, { kind: 'video', url: 'https://vr-1.ozone.ru/vod/video-72/ASSET/asset.mp4' }]);
  assert.equal(streams.length, 1); assert.ok(streams[0].url.includes('/vod/')); assert.equal(streams[0].observedSourceUrls.length, 2);
});
