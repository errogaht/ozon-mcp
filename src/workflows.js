import { ConsumerOperations, validateCardPrice } from './operations.js';
import { evidenceText, entityId, clickObserved } from './adapter.js';
import { outputSchemas } from './contracts.js';
import { scopedURL, finalButtonAllowed } from './action-policy.js';
import { inferredBudget, searchURL, productId } from './policy.js';
import { deliveryDates, deadlineProof } from './delivery.js';
import { AppError, stateDir, writePrivateJSON } from './config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { digest } from './confirmation.js';
import { readCardsInPage, visibleCardFacts } from './snapshot.js';
import { enclosingEvidence, containsLiteral } from './evidence.js';

/** Workflow goals are narrowly scoped instructions for the small adapter model.
 * They never grant final-submit authority. Deterministic postchecks reject
 * changed targets/prices/preferences rather than asking Luna to judge safety. */
export class ConsumerWorkflows extends ConsumerOperations {
  async search(args, cfg) {
    const max = args.maxPriceRub ?? inferredBudget(args.query); const limit = Math.min(args.limit ?? cfg.agent.defaultLimit, cfg.agent.maxLimit);
    const phrase = args.query.replace(/^(?:найди|найти|подбери|покажи|ищу)\s+/iu, '').replace(/(?:до|не\s+дороже)\s*\d[\d\s.,]*(?:тыс\.?|[кk])?\s*(?:руб(?:лей|ля)?\.?|₽|р\b)?/iu, '').trim().slice(0, 300);
    const adapter = await this.open(searchURL(phrase, max), { kind: 'filter_apply', scope: 'catalog', mode: 'read' }, cfg);
    let applied = null;
    if ((args.sort && args.sort !== 'relevance') || args.minPriceRub !== undefined || args.brands?.length || args.deliveryWithinDays !== undefined || args.filters?.length) {
      applied = (await this.applyFilters(adapter, { ...args, maxPriceRub: max }, cfg)).data;
      if (applied.missing.length) return { status: 'filter_unavailable', query: args.query, requestedFilters: args, applied, products: [], note: 'Не все обязательные фильтры удалось применить; выдача не представлена как соответствующая запросу.' };
    }
    adapter.task.kind = 'search_cards';
    const initialCards = await adapter.page.evaluate(readCardsInPage);
    const { data, meta } = await this.adapt(adapter, { action: 'Read matching search cards with all visible metadata, using exact card-level sourceRefs.', request: args.query, wanted: limit,
      observedCandidates: initialCards.map(({ media, ...card }) => card),
      requirements: 'Select matching product types, not accessories unless requested. Return matching candidates EVEN WHEN their Ozon Card price basis is unknown; the host verifies unknown prices separately on their product pages. Copy exact observed URL; no invented links. Collect product rating (not store rating), review/question counts if shown, delivery label, stock/badges and images. Scroll for more candidates if needed. Unknown fields null. Do not waste calls proving a price basis absent from search. Do not click buy/cart/favorites. Do not claim all catalog results.' }, outputSchemas.search_cards, cfg);
    const observedCards = new Map((await adapter.page.evaluate(readCardsInPage)).map(card => [card.sku, card]));
    const products = []; const rejected = [];
    const rowsBySku = new Map(data.items.map(item => [productId(item.url), item]));
    // Search is a UI adapter, not the final product adviser. Preserve Ozon's
    // displayed order; the outer agent evaluates appliance type/specs/reviews.
    // Literal card facts also avoid Luna shortening a long title or dropping a
    // valid card merely because its bank price needs a separate verification.
    const visible = [...observedCards.values()];
    const rows = visible.length ? visible.slice(0, limit).map(card => rowsBySku.get(card.sku) ?? { title: card.title, url: card.url, sourceRef: null,
      priceOzonCard: { amount: null, sourceRef: null, basisLabel: null, verifiedOzonCard: false }, deliveryLabel: null, stockLabel: null, badges: [], sellerName: null, mediaRefs: [] }) : data.items;
    for (const raw of rows) {
      const sku = productId(raw.url);
      let url; try { url = scopedURL(raw.url); } catch { rejected.push({ sku, reason: 'invalid_url' }); continue; }
      if (!productId(url) || !adapter.links.has(url) && ![...adapter.links].some(link => productId(link) === productId(url))) { rejected.push({ sku, reason: 'url_not_observed' }); continue; }
      const candidate = observedCards.get(sku) ?? initialCards.find(card => card.sku === sku);
      const text = candidate?.cardText ?? await this.hydrateRef(adapter, raw.sourceRef);
      const title = candidate?.title ?? raw.title;
      if (!text || !text.includes(title)) { rejected.push({ sku, reason: 'title_not_observed' }); continue; }
      const literal = visibleCardFacts(text);
      let price = validateCardPrice(raw.priceOzonCard, adapter); let delivery = deliveryDates(literal.deliveryLabel ?? raw.deliveryLabel);
      if (!price.verified || !/(?:ozon|озон)\s*(?:карт|банк)/iu.test(text)) {
        if (this.remaining(cfg) < 2000) { rejected.push({ sku, reason: 'operation_budget' }); break; }
        try { price = await this.priceForProduct(url, cfg); }
        catch (error) { if (!['operation_budget', 'timeout', 'step_limit'].includes(error.code)) throw error; rejected.push({ sku, reason: 'price_verification_incomplete' }); break; }
      }
      if (delivery.earliest === null && price.delivery?.earliest) delivery = { ...price.delivery, source: 'product_page' };
      if (max !== null && (price.amount === null || price.amount > max) || args.minPriceRub !== undefined && (price.amount === null || price.amount < args.minPriceRub)) { rejected.push({ sku, reason: 'ozon_card_budget_unverified' }); continue; }
      if (args.deliveryWithinDays !== undefined) {
        const proof = deadlineProof(delivery, args.deliveryWithinDays, applied?.deliveryWithinDays);
        if (!proof.matches) { rejected.push({ sku, reason: 'delivery_deadline_unverified' }); continue; }
        if (proof.source === 'selected_filter') delivery = { ...delivery, deadlineVerifiedByFilter: proof.withinDays };
      }
      products.push({ evidenceId: entityId('card', sku, text), sku: productId(url), title, url: url.split('?')[0], priceOzonCard: price, priceRub: price.amount,
        rating: literal.rating, ratingKind: literal.ratingKind, storeRating: literal.storeRating, reviewsCount: literal.reviewsCount, questionsCount: literal.questionsCount,
        delivery, stockLabel: literal.stockLabel ?? raw.stockLabel, badges: raw.badges, sellerName: raw.sellerName,
        media: candidate?.media?.length ? await this.media.register(candidate.media, { pageUrl: adapter.page.url(), sourceRef: raw.sourceRef }) : await this.resolvedMedia(adapter, raw.mediaRefs), cardText: text, observedAt: new Date().toISOString() });
      if (products.length >= limit) break;
    }
    return { status: products.length >= limit ? 'complete' : products.length ? 'partial' : rejected.length ? 'constraints_unverified' : data.missing.length ? 'adapter_incomplete' : 'no_results',
      query: args.query, requestedLimit: limit, maxPriceRub: max, sort: args.sort ?? 'relevance', appliedFilters: applied,
      products, rejected, coverage: this.coverage(data, products.length), observedAt: new Date().toISOString(), agent: meta };
  }
  async orders(args, cfg) {
    const requested = args.status ?? 'active';
    const cursor = args.cursor ? await this.readCursor(args.cursor, 'orders', requested) : null;
    if (requested === 'all') {
      const limit = args.limit ?? 30;
      const ended = { items: [], nextCursor: null, coverage: { complete: true, hasMore: false, missing: [] } };
      const active = cursor?.activeDone ? ended : await this.orders({ status: 'active', limit: Math.ceil(limit / 2), cursor: cursor?.activeCursor ?? undefined }, cfg);
      const completed = cursor?.completedDone ? ended : await this.orders({ status: 'completed', limit: Math.floor(limit / 2) || 1, cursor: cursor?.completedCursor ?? undefined }, cfg);
      const missing = [...new Set([...(cursor?.missing ?? []), ...active.coverage.missing, ...completed.coverage.missing])];
      return { status: 'all', items: [...active.items, ...completed.items].slice(0, limit),
        coverage: { complete: active.coverage.complete && completed.coverage.complete && !missing.length, missing },
        nextCursor: active.nextCursor || completed.nextCursor ? await this.saveCursor('orders', 'all', { activeCursor: active.nextCursor, completedCursor: completed.nextCursor,
          activeDone: active.coverage.hasMore === false, completedDone: completed.coverage.hasMore === false, missing }) : null };
    }
    const adapter = await this.open(cursor?.resumeUrl ?? 'https://www.ozon.ru/my/orderlist/', { kind: 'orders', scope: 'orders', mode: 'read', initialViewportOnly: false }, cfg);
    await adapter.observe({ viewportOnly: false });
    if (requested === 'completed') {
      const tabs = [...adapter.current.nodes.values()].filter(node => /^Заверш[её]нные$/iu.test(node.text.trim()));
      if (tabs.length === 1) await adapter.act('browser_click', { sourceRef: tabs[0].source, purpose: 'Read completed orders tab' });
    }
    if (cursor?.scrollY) { await adapter.page.evaluate(y => window.scrollTo(0, y), cursor.scrollY); await adapter.page.waitForTimeout(500); }
    const { data, meta } = await this.adapt(adapter, { action: 'Read current order list and planned deliveries without changing any order. The host already opened the requested tab.',
      status: requested, wanted: args.limit ?? 30, seenOrderNumbers: cursor?.seen ?? [],
      requirements: 'Return each order separately with exact products, current status and displayed delivery dates, order number/detail link, whether return/review controls exist. Use sourceRef for its FULL order card. Skip seen orders; scroll/load more for NEW ones. Do not cancel, reorder, pay, confirm receipt or submit. hasMore=true unless end established. Never substitute active orders for completed.'
    }, outputSchemas.orders, cfg);
    if (data.appliedStatus !== requested && requested !== 'all') return { status: 'filter_unverified', requestedStatus: requested, appliedStatus: data.appliedStatus, items: [],
      coverage: { complete: false, missing: [...data.missing, 'Не подтверждена выбранная вкладка состояния заказов.'] }, agent: meta };
    const filtered = data.items.filter(item => requested !== 'completed' || /доставлен|получен|заверш|выдан|возврат|отмен/iu.test(item.status ?? '') && !/можно забирать|в пути|в сборке|ожидает оплаты|передан.*достав/iu.test(item.status ?? ''));
    if (filtered.length !== data.items.length) data.missing.push('Заказы с активными статусами не включены в завершённые.');
    const items = [];
    for (const [index, item] of filtered.entries()) {
      if (item.orderNumber && cursor?.seen?.includes(item.orderNumber)) continue;
      const rawText = await this.hydrateRef(adapter, item.sourceRef);
      if (item.status && !containsLiteral(rawText, item.status)) { data.missing.push('Статус одного заказа не подтверждён собственным блоком.'); if (requested === 'completed') continue; item.status = null; }
      const media = await this.resolvedMedia(adapter, [item.sourceRef]);
      item.products = this.groundedOrderProducts(item.products, rawText, media, data.missing);
      const id = entityId('order', item.orderNumber ?? '', item.detailUrl ?? '', item.date ?? '', rawText ?? '', media.map(image => image.url).join('|'), !item.orderNumber ? String(index) : '');
      if (cursor?.seenIds?.includes(id)) continue;
      items.push({ id, ...item, rawText, media });
      // Overview cards can omit both names and a link. The opaque orderId
      // still lets the outer agent request a bounded UI detail-opening task.
      await writePrivateJSON(path.join(stateDir(), 'entities', id + '.json'), { id, status: requested, listUrl: adapter.page.url(), detailUrl: item.detailUrl, orderNumber: item.orderNumber,
        date: item.date, index, rawText, thumbnails: media.map(image => image.url), ownerHash: await this.ownerHash(), observedAt: new Date().toISOString() });
      if (items.length >= (args.limit ?? 30)) break;
    }
    const seen = [...new Set([...(cursor?.seen ?? []), ...items.map(item => item.orderNumber).filter(Boolean)])];
    if (data.hasMore && !items.length) data.missing.push('Пагинация не продвинулась; повторяющийся курсор не выдан.');
    return { status: requested, items, coverage: this.coverage(data, items.length), nextCursor: data.hasMore && items.length ? await this.saveCursor('orders', requested, { seen, seenIds: [...(cursor?.seenIds ?? []), ...items.map(item => item.id)], resumeUrl: adapter.page.url(), scrollY: await adapter.page.evaluate(() => scrollY) }) : null, observedAt: new Date().toISOString(), agent: meta };
  }
  async orderDetail(args, cfg) {
    let record = null;
    if (args.orderId) {
      try { record = JSON.parse(await fs.readFile(path.join(stateDir(), 'entities', args.orderId + '.json'), 'utf8')); } catch { throw new AppError('unknown_order', 'Заказ ещё не наблюдался. Сначала вызовите ozon_orders.'); }
      await this.browser.connect(cfg);
      if (record.ownerHash && record.ownerHash !== await this.ownerHash()) throw new AppError('account_changed', 'ID заказа относится к другому сохранённому аккаунту. Прочитайте текущие заказы заново.');
    }
    const target = args.url ?? record.detailUrl ?? record.listUrl;
    const { ownerHash: ignoredOwner, ...requestedRecord } = record ?? {};
    const { data, adapter, meta } = await this.extract('orders', scopedURL(target, 'orders'), { action: record && !record.detailUrl ? 'Open ONLY the exact recorded order card, then read its details.' : 'Read this exact order in full.',
      requestedOrder: record ? requestedRecord : null, wanted: 1,
      requirements: 'Return exact order number, items/names/quantities, status, tracking and promised/actual delivery, return/review availability. If starting from overview, compare recorded date/status/card text AND thumbnails; index is only a fallback when identity matches. Click its status/card to OPEN DETAILS, never cancel/pay/reorder/return/review. Read current URL after opening; do not invent detail links. If ambiguous report missing rather than choosing another order.' }, cfg, { scope: 'orders', allowOrderOpen: true, initialViewportOnly: false });
    const detailOpen = /^\/my\/(?:orderdetails|order)\b/.test(new URL(adapter.page.url()).pathname);
    if (!detailOpen) return { status: 'detail_not_open', orderId: args.orderId ?? null, items: [], coverage: { complete: false, missing: [...data.missing, 'Не открыты детали точного заказа.'] }, agent: meta };
    if (record?.orderNumber && !data.items.some(item => item.orderNumber === record.orderNumber)) return { status: 'identity_unverified', items: [], coverage: { complete: false, missing: ['Детали не подтверждают исходный номер заказа.'] } };
    const pageText = await adapter.page.locator('body').innerText();
    return { url: adapter.page.url(), orderId: args.orderId ?? null, items: data.items.map(item => ({ ...item,
      products: this.groundedOrderProducts(item.products, pageText, [], data.missing), rawText: evidenceText(adapter, item.sourceRef) })), coverage: this.coverage(data), agent: meta };
  }
  groundedOrderProducts(products, text, media, missing) {
    // Overview thumbnails are not product names or a quantity of one. Retain
    // only literal title/alt evidence; order_detail can reveal omitted names.
    const result = products.filter(product => containsLiteral(text, product.title) || media.some(image => containsLiteral(image.alt, product.title)));
    if (result.length < products.length) missing.push('Названия некоторых товаров не подтверждены текстом/alt; откройте order_detail.');
    return result.map(product => ({ ...product, quantity: product.quantity !== null && new RegExp(`(?:^|\\D)${product.quantity}\\s*шт`, 'iu').test(text ?? '') ? product.quantity : null }));
  }
  async collections(args, cfg) {
    const { data, adapter, meta } = await this.extract('collections', 'https://www.ozon.ru/my/favorites/', { action: 'Read favorites, wishlists and collections. Open the collections tab if present. Return exact names, descriptions, visibility, cover media and item counts; do not edit or create anything.' }, cfg, { scope: 'collections' });
    return { items: await Promise.all(data.items.map(async item => ({ ...item, cover: item.coverRef ? await this.resolvedMedia(adapter, [item.coverRef]) : [] }))), coverage: this.coverage(data), agent: meta };
  }
  async cart(args, cfg) {
    const { data, adapter, meta } = await this.extract('cart', 'https://www.ozon.ru/cart', { action: 'Read the cart only. Never toggle selections, change quantities, delete items or proceed to purchase.', requirements: 'Return items with exact quantities, selection state, Ozon Card price and delivery. Distinguish total selection amount from sum of all items.' }, cfg, { scope: 'checkout' });
    return { items: data.items.map(item => ({ ...item, priceOzonCard: validateCardPrice(item.priceOzonCard, adapter) })), total: data.total, coverage: this.coverage(data, data.items.length), agent: meta };
  }
  async reversible(kind, args, cfg) {
    if (kind === 'collection_create') return this.createCollection(args, cfg);
    const specs = {
      collection_create: { url: 'https://www.ozon.ru/my/favorites/', scope: 'collections', action: 'Create ONE collection with EXACT requested name, description, visibility and cover. Do not alter an existing unrelated collection.' },
      favorite: { url: args.url, scope: 'collections', action: 'Ensure this exact product is saved to the requested favorites/wishlist/collection. Do not toggle it off if already saved; do not substitute another collection.' },
      cart_add: { url: args.url, scope: 'checkout', action: 'Ensure this exact product is in cart with EXACT requested quantity. Inspect current state first; do not blindly increment an already-present item. Do not touch other products or proceed to purchase.' }
    };
    const spec = specs[kind];
    if (!args.apply) return { status: 'preview', action: kind, requested: args, instruction: 'Для выполнения этого обратимого изменения вызовите тот же инструмент с apply=true, только если действие следует из поручения владельца.' };
    const destination = args.listName ?? args.collectionName;
    if (kind === 'favorite' && ['collection', 'wishlist'].includes(args.target) && !destination) throw new AppError('collection_required', 'Укажите точное название подборки/вишлиста в listName.');
    const adapter = await this.open(spec.url, { kind, scope: spec.scope, mode: 'mutate', fixedProductSku: productId(args.url), mediaIds: args.coverMediaId ? [args.coverMediaId] : [] }, cfg);
    let cover = null;
    if (args.coverMediaId) cover = await this.media.read(args.coverMediaId);
    const result = await this.adapt(adapter, { action: spec.action, requested: args, destination, cover,
      requirements: 'Perform only this reversible mutation. Return exact targetSku and evidenceRef. For cart quantityRef must show ACTUAL resulting quantity, not requested args. For favorite membershipRef must prove checked membership in exact destination (or filled heart/remove-from-favorites state). В избранное is an ADD action, not evidence already saved. Do not remove existing favorites, duplicate quantities, touch unrelated products or click final order/discount/return/review submission.' }, outputSchemas.mutation, cfg);
    await adapter.observe({ viewportOnly: false });
    for (const key of ['evidenceRef', 'quantityRef', 'membershipRef']) result.data[key] = await this.currentProof(adapter, result.data[key]);
    result.data.membershipRef ??= result.data.evidenceRef;
    await this.hydrateRef(adapter, result.data.evidenceRef); await this.hydrateRef(adapter, result.data.quantityRef); await this.hydrateRef(adapter, result.data.membershipRef);
    const evidence = evidenceText(adapter, result.data.evidenceRef);
    const target = kind === 'collection_create' ? args.name : productId(args.url);
    let proof = !!evidence && result.data.targetSku === target;
    if (kind === 'cart_add') {
      const quantity = (evidenceText(adapter, result.data.quantityRef) ?? '').trim();
      proof &&= result.data.quantity === args.quantity && (quantity === String(args.quantity) || new RegExp(`(?:^|\\D)${args.quantity}\\s*шт`, 'iu').test(quantity)) && /в корзине|товар.*корзин/iu.test(evidence);
    } else if (kind === 'favorite') {
      const member = adapter.evidence(result.data.membershipRef);
      const selected = member && (member.checked === true || member.selected === true || member._raw?.pressed === true);
      const saved = /удалить\s+из\s+избранн|убрать\s+из\s+избранн|в\s+избранном|(?:товар\s+)?(?:добавлен|сохран[её]н)/iu.test((member?.text ?? '') + ' ' + (member?.name ?? '') + ' ' + evidence);
      proof &&= !!(selected || saved);
      if (destination) proof &&= result.data.destination?.toLocaleLowerCase() === destination.toLocaleLowerCase() && !!enclosingEvidence(adapter, result.data.membershipRef, text => containsLiteral(text, destination), 1000);
    }
    const verified = proof && !result.data.missing.length;
    return { status: verified ? result.data.applied ? 'applied' : 'already_present' : 'unverified', stateVerified: verified, action: kind, target, evidence, missing: result.data.missing,
      instruction: verified ? 'Нужное состояние подтверждено Ozon.' : 'Изменение могло примениться. Сначала прочитайте корзину/список, не повторяйте изменение вслепую.', agent: result.meta };
  }

  async createCollection(args, cfg) {
    if (!args.apply) return { status: 'preview', action: 'collection_create', requested: args, instruction: 'Перед созданием проверьте название/описание/обложку/isPublic; apply=true допустим по поручению владельца.' };
    const adapter = await this.open('https://www.ozon.ru/my/favorites/', { kind: 'collection_create', scope: 'collections', mode: 'prepare', mediaIds: args.coverMediaId ? [args.coverMediaId] : [], allowCollectionCommit: false }, cfg);
    const staged = await this.adapt(adapter, { action: 'Open creation form for ONE collection; fill exact requested fields, do NOT click its final Save/Create button.', requested: args,
      requirements: 'If an existing collection has same name, stop/report missing rather than duplicating/overwriting. Set visibility EXACTLY isPublic; identify actual switch/checkbox ref. Upload assigned cover. Ozon may show Выбрать товары as NEXT step: return it as saveButtonRef WITHOUT clicking; host validates current fields first. Return all field refs from latest snapshot.' }, outputSchemas.collection_form, cfg);
    const data = staged.data; const missing = [...data.missing];
    const name = await this.hydrateRef(adapter, data.nameRef); const description = await this.hydrateRef(adapter, data.descriptionRef);
    if (name !== args.name) missing.push('Не подтверждено точное название.');
    if (args.description !== undefined && description !== args.description) missing.push('Не подтверждено точное описание.');
    let visibility = null;
    if (data.visibilityRef) {
      const [snapshot, ref] = data.visibilityRef.split(':');
      if (snapshot === adapter.current.id) visibility = (await adapter.target(snapshot, ref)).checked;
    }
    if (visibility !== args.isPublic) missing.push('Не подтверждён фактический переключатель публичности.');
    if (args.coverMediaId && !adapter.uploaded.has(args.coverMediaId)) missing.push('Не подтверждена загрузка выбранной обложки.');
    if (!data.saveButtonRef) missing.push('Не обнаружена кнопка создания/сохранения.');
    if (missing.length) return { status: 'prepare_incomplete', action: 'collection_create', missing, requested: args, agent: staged.meta };
    let [snapshot, ref] = data.saveButtonRef.split(':'); let target = await adapter.target(snapshot, ref);
    if (/^Выбрать товары$/iu.test(target.name || target.text)) {
      await clickObserved(adapter.currentLocator(snapshot, ref)); await adapter.page.waitForTimeout(800);
      adapter.task.collectionSelectionOnly = true; adapter.task.allowedProductSkus = (args.productUrls ?? []).map(productId);
      const selection = await this.adapt(adapter, { action: 'Select EXACT requested products for the new collection, then STOP before final Save/Create.',
        productUrls: args.productUrls ?? [],
        requirements: 'Do not select unrelated favorites. Empty requested list means zero products, only if Ozon allows empty collections. Return EVERY actually selected product with its full row ref and CHECKED checkbox ref, plus final saveButtonRef. Do not click final create/save.' }, outputSchemas.collection_selection, cfg);
      const selected = selection.data.selected; const expected = [...new Set((args.productUrls ?? []).map(productId))].sort();
      const actual = [...new Set(selected.map(item => productId(item.url)))].sort();
      if (JSON.stringify(actual) !== JSON.stringify(expected) || selection.data.missing.length || selected.some(item => adapter.evidence(item.checkedRef)?.checked !== true)) return { status: 'prepare_incomplete', action: 'collection_create',
        requested: args, missing: [...selection.data.missing, 'Не подтверждён точный состав новой подборки. Финальное сохранение не нажато.'] };
      if (!selection.data.saveButtonRef) return { status: 'prepare_incomplete', action: 'collection_create', missing: ['Не найдена финальная кнопка сохранения.'] };
      [snapshot, ref] = selection.data.saveButtonRef.split(':'); target = await adapter.target(snapshot, ref);
    }
    if (!/^(?:создать|создать подборку|сохранить|сохранить подборку)$/iu.test(target.name || target.text)) throw new AppError('invalid_submit_target', 'Кнопка не является сохранением подборки.');
    await clickObserved(adapter.currentLocator(snapshot, ref));
    await adapter.page.waitForTimeout(1200);
    const text = await adapter.page.locator('body').innerText();
    const verified = text.includes(args.name) && (/подборк[а-я]*\s+(?:создан|сохран)|(?:создан|сохран)[а-я]*\s+подборк/iu.test(text) || /^\/selections\/(?!list|create)[\w-]+/.test(new URL(adapter.page.url()).pathname));
    return { status: verified ? 'applied' : 'unverified', action: 'collection_create', name: args.name, isPublic: args.isPublic, coverMediaId: args.coverMediaId ?? null,
      pageUrl: adapter.page.url(), note: verified ? 'Создание подтверждено Ozon.' : 'Кнопка сохранения нажата один раз. Проверьте список подборок; не создавайте дубликат вслепую.', agent: staged.meta };
  }

  /** Preparation is authorized navigation/form filling, NEVER final submission.
   * A token is issued only if target/payment/amount/delivery facts are complete.
   * Revalidation uses this same routine without issuing another token. */
  async prepareAction(kind, args, cfg, issueToken = true) {
    const checkout = kind === 'checkout';
    const target = args.url ?? args.orderUrl;
    const payment = args.payment ?? cfg.consumer.payment;
    const pickup = args.pickupPoint ?? cfg.consumer.pickupPoint;
    const adapter = await this.open(target, { kind, scope: checkout ? 'checkout' : kind === 'discount' ? 'catalog' : 'orders', mode: 'prepare', fixedProductSku: checkout ? productId(target) : null, mediaIds: args.mediaIds ?? args.evidenceMediaIds ?? [] }, cfg);
    const originalProductTitle = checkout ? await adapter.page.locator('h1').first().innerText().catch(() => '') : null;
    let originalOrderNumber = null;
    if (['return', 'review'].includes(kind)) {
      const original = await adapter.page.locator('body').innerText();
      originalOrderNumber = original.match(/заказ\s*(?:№|номер)?\s*([\d]+(?:[-–]\d+){1,4})/iu)?.[1] ?? null;
      if (!originalOrderNumber || !original.toLocaleLowerCase().includes(args.productTitle.toLocaleLowerCase())) return { status: 'prepare_incomplete', action: kind,
        missing: ['Не подтверждены номер конкретного заказа и точный товар. Сначала откройте детали заказа и используйте его ссылку.'] };
    }
    const goals = {
      checkout: { action: 'Open Buy now for THIS exact product, then inspect/configure the pre-submit checkout. NEVER click Оформить заказ or any payment/confirmation final.',
        product: target, quantity: args.quantity ?? 1, payment, pickupPoint: pickup,
        requirements: 'A pickup address can include city and ул./дом prefixes. Compare requested street/house; keep it if those match. Change address ONLY when genuinely different. Choose Ozon installment (Ozon Рассрочка offered by Ozon) or Ozon Bank exactly as requested. Never pay-after-receipt, another bank or credit silently. Read actual delivery ETA inside Buy now/checkout (often a separate item delivery block). delivery.dateSourceRef is ONLY delivery arrival date; NOT Срок хранения or a payment date. delivery.pickupSourceRef is the actual pickup address. paymentSourceRef must include selected Ozon payment name AND complete schedule/terms. Open Выбрать срок и посмотреть график to READ selected repayment terms if needed, then close without changing term. Individual item price need not be shown if SKU/quantity/final total are verified. additionalChargeRefs point to actual extra charges. Return exact final button ref without clicking.' },
      discount: { action: 'Open ONLY the discount-request form for this product; fill requested price/message if supported. DO NOT send the request.', requested: args, requirements: 'If Хочу скидку is itself an immediate final action rather than a form opener, do not click it. Return final button ref only after the form and requested fields are visible. Missing functionality is not success.' },
      return: { action: 'Find THIS exact completed order item and prepare its return form, without submitting.', requested: args,
        requirements: 'Use exact order/product/quantity. Select only this one item and the provided truthful reason/comment, upload assigned photos. Do not cancel, return unrelated items or submit. identityRef must prove exact product in the form, orderRef original order number. selectedItems must list ALL selected return items/quantities. fields must include the actually CHECKED selected reason control and its full ref. Report eligibility/refund method/instructions. Point to final submit only.' },
      review: { action: 'Open the review form for THIS exact purchased order item. Fill EXACT owner-provided stars/text/pros/cons and assigned media, without publication.', requested: args,
        requirements: 'Do not invent experience or alter owner text. Do not publish/vote. identityRef must prove exact product in the form; orderRef original order number. fields must include ACTUALLY CHECKED rating radio/pressed-star ref, exact text/pros/cons inputs. Return final button without clicking.' }
    };
    const result = await this.adapt(adapter, goals[kind], checkout ? outputSchemas.checkout : outputSchemas.form, cfg);
    const data = result.data; const warnings = [...data.missing]; const missing = checkout ? [] : [...data.missing];
    const observedQuantityRows = () => [...adapter.current.nodes.values()].filter(node => /^\d+\s*шт\.?$/iu.test(node.directText.trim())).length;
    let observedItemCount = checkout ? observedQuantityRows() : null;
    if (checkout && (!data.items.length || data.items.some(item => !containsLiteral(evidenceText(adapter, item.sourceRef), item.title) || !item.quantitySourceRef))) {
      const detail = await this.adapt(adapter, { action: 'Read ONLY the exact checkout items and quantities. No other checkout research.',
        expectedSku: productId(target), expectedQuantity: args.quantity ?? 1,
        instructions: 'The checkout usually shows ONLY a thumbnail near 1 товар / delivery date. Use browser_view to identify that thumbnail, then click the observed unnamed clickable media ref in that delivery block. It opens item details. Read full product title/SKU/quantity from the actual details popup. sourceRef=full item row, quantitySourceRef=actual quantity text/control. Do not infer these from requested args. Unit price can be null. NEVER click Оформить заказ. Finish with exact observed item refs.' }, outputSchemas.checkout_items, { ...cfg, adapter: { ...cfg.adapter, maxSteps: 8 } });
      data.items = detail.data.items; warnings.push(...detail.data.missing);
      observedItemCount = observedQuantityRows();
      for (const item of data.items) { await this.hydrateRef(adapter, item.sourceRef); await this.hydrateRef(adapter, item.quantitySourceRef); }
      await adapter.page.keyboard.press('Escape');
      result.meta.subtasks = [detail.meta];
    }
    // Capture current input values before refreshing final-button observation.
    // aria text alone can omit textarea values; original typed text is retained.
    if (!checkout) {
      for (const field of data.fields) await this.hydrateRef(adapter, field.sourceRef);
      for (const item of data.selectedItems) await this.hydrateRef(adapter, item.quantityRef);
    }
    else for (const item of data.items) { await this.hydrateRef(adapter, item.sourceRef); await this.hydrateRef(adapter, item.quantitySourceRef); }
    // Discover the final button in a NEW observation, never re-use a stale
    // model ref. This only prepares a capability; it does not click anything.
    await adapter.observe({ viewportOnly: false });
    const candidates = [...adapter.current.nodes.entries()].filter(([, node]) => node.role === 'button' && finalButtonAllowed(kind, node.name || node.text));
    let button = null;
    if (candidates.length === 1) { const [ref] = candidates[0]; button = { snapshot: adapter.current.id, ref, target: await adapter.target(adapter.current.id, ref) }; }
    else missing.push(candidates.length ? 'Неоднозначная конечная кнопка.' : 'Не обнаружена конечная кнопка.');
    if (button && !finalButtonAllowed(kind, button.target.name || button.target.text)) missing.push('Назначение конечной кнопки не подтверждено.');
    let facts;
    if (checkout) {
      if (!/^\/(?:gocheckout|checkout|my\/checkout)\/?$/.test(new URL(adapter.page.url()).pathname)) missing.push('Не открыт настоящий экран оформления заказа.');
      const expectedSku = productId(target);
      if (adapter.task.checkoutEntrySku !== expectedSku) missing.push('Не подтверждён переход Купить сейчас с точного исходного SKU.');
      // Some checkout popups intentionally omit SKU. Bind it to the verified
      // Buy-now click on the exact original product, never to model inference.
      for (const item of data.items) if (item.sku === null && adapter.task.checkoutEntrySku === expectedSku) item.sku = expectedSku;
      if (!expectedSku || data.items.length !== 1 || data.items[0].sku !== expectedSku || data.items[0].quantity !== (args.quantity ?? 1)) missing.push('Состав заказа не совпадает с запрошенным SKU/количеством.');
      if (observedItemCount > 0 && observedItemCount !== data.items.length) missing.push('В окне состава присутствуют дополнительные позиции, отсутствующие в плане.');
      for (const item of data.items) {
        const quantityPattern = new RegExp(`(?:^|\\D)${item.quantity}\\s*шт`, 'iu');
        const quantityRow = enclosingEvidence(adapter, item.sourceRef, text => containsLiteral(text, item.title) && quantityPattern.test(text), 5000);
        const node = quantityRow ?? enclosingEvidence(adapter, item.sourceRef, text => containsLiteral(text, item.title), 5000);
        const text = node?.text ?? evidenceText(adapter, item.sourceRef) ?? '';
        if (!containsLiteral(text, item.title)) missing.push('Название позиции не подтверждено её собственным блоком.');
        const quantity = (evidenceText(adapter, item.quantitySourceRef) ?? '').trim();
        if (quantity !== String(item.quantity) && !quantityPattern.test(quantity) && !quantityRow) missing.push('Количество позиции не подтверждено в его собственном контроле.');
      }
      const totalText = evidenceText(adapter, data.totalSourceRef) ?? '';
      if (!(data.totalRub > 0) || !totalText.replace(/\s/g, '').includes(String(data.totalRub))) missing.push('Не подтверждена итоговая сумма заказа в её собственном блоке.');
      if (args.maxTotalRub !== undefined && data.totalRub > args.maxTotalRub) missing.push('Итог превышает разрешённый владельцем maxTotalRub.');
      if (!enclosingEvidence(adapter, data.totalSourceRef, text => /итого|сумма\s+всех\s+платежей|к\s+оплате/iu.test(text), 600)) missing.push('Сумма не связана с подписью итогового платежа.');
      const payNode = enclosingEvidence(adapter, data.paymentSourceRef, text => /(?:ozon|озон).*рассроч|рассроч.*(?:ozon|озон)|(?:ozon|озон)\s*(?:банк|карт)/iu.test(text));
      const payText = payNode?.text ?? evidenceText(adapter, data.paymentSourceRef) ?? '';
      const paymentMatches = payment === 'ozon_installment' ? /(?:ozon|озон).*рассроч|рассроч.*(?:ozon|озон)/iu.test(payText) : /(?:ozon|озон)\s*(?:банк|карт)/iu.test(payText);
      if (!paymentMatches || /после\s+получения|при\s+получении/iu.test(payText)) missing.push('Не подтверждён требуемый способ оплаты.');
      if (data.paymentSourceRef && adapter.evidence(data.paymentSourceRef).checked === false) missing.push('Указанный способ оплаты не выбран.');
      const deliveryText = evidenceText(adapter, data.delivery.dateSourceRef ?? data.delivery.sourceRef) ?? '';
      const pickupText = evidenceText(adapter, data.delivery.pickupSourceRef ?? data.delivery.sourceRef) ?? '';
      const dates = deliveryDates(deliveryText);
      if (!dates.earliest) missing.push('Срок доставки не подтверждён в собственном блоке.');
      if (data.delivery.method !== 'pickup') missing.push('Не подтверждена доставка в ПВЗ.');
      if (pickup && !this.pickupMatches(pickup, data.delivery.pickupPoint)) missing.push('ПВЗ не совпадает с выбранным адресом.');
      if (pickup && !this.pickupMatches(pickup, pickupText)) missing.push('Адрес ПВЗ не подтверждён в собственном блоке доставки.');
      // Bind the digest to literal UI facts, not Luna's variable paraphrases.
      // Installment principal total alone is insufficient: repayment schedule
      // and financing terms remain in the exact observed payment block.
      const charges = [...new Set((data.additionalChargeRefs ?? []).map(ref => evidenceText(adapter, ref)).filter(Boolean))].sort();
      if (data.additionalCharges.length && !charges.length) missing.push('Дополнительные платежи указаны без собственных источников.');
      facts = { productUrl: target.split('?')[0], items: data.items.map(item => ({ title: originalProductTitle || item.title, sku: item.sku, quantity: item.quantity })), totalRub: data.totalRub, currency: 'RUB',
        payment, paymentTerms: payText, delivery: { method: data.delivery.method, pickupPoint: pickup, pickupSourceText: pickupText, sourceText: deliveryText, earliestDate: dates.earliest, latestDate: dates.latest }, additionalCharges: charges };
    } else {
      // Re-read every prepared form proof after the final fresh observation.
      // A checked star or refund value from an earlier wizard step cannot
      // silently stand in for a control that has since changed/disappeared.
      for (const field of data.fields) field.sourceRef = await this.currentProof(adapter, field.sourceRef);
      data.identityRef = await this.currentProof(adapter, data.identityRef); data.orderRef = await this.currentProof(adapter, data.orderRef);
      data.termsRefs = (await Promise.all((data.termsRefs ?? []).map(ref => this.currentProof(adapter, ref)))).filter(Boolean);
      for (const item of data.selectedItems) for (const key of ['sourceRef', 'checkedRef', 'quantityRef']) item[key] = await this.currentProof(adapter, item[key]);
      const fields = [];
      for (const field of data.fields) {
        const actual = await this.hydrateRef(adapter, field.sourceRef);
        if (actual === null) missing.push(`Не подтверждено поле: ${field.name}`);
        fields.push({ name: field.name, value: actual ?? '' });
      }
      const fieldText = fields.map(f => f.value).join('\n');
      const exactField = value => fields.some((field, index) => field.value === value && ['textbox', 'combobox'].includes(adapter.evidence(data.fields[index].sourceRef)?.role));
      if (kind === 'review') {
        for (const key of ['text', 'pros', 'cons']) if (args[key] !== undefined && !exactField(args[key])) missing.push(`Не подтверждено точное поле отзыва: ${key}`);
        const chosenRating = data.fields.some(field => {
          const node = adapter.evidence(field.sourceRef);
          return node && (node.checked === true || node.selected === true || node._raw?.pressed === true) && /зв[её]зд|оценк|рейтинг/iu.test(field.name + node.name) && new RegExp(`(?:^|\\D)${args.stars}(?:\\D|$)`).test(node.text + ' ' + node.name);
        });
        if (!chosenRating) missing.push('Не подтверждён фактически выбранный контрол оценки; подпись ненажатой звезды недостаточна.');
      }
      if (kind === 'return') {
        const selectedReason = data.fields.some(field => { const node = adapter.evidence(field.sourceRef); return node && (node.checked === true || node.selected === true) && containsLiteral(node.text + ' ' + node.name, args.reason); });
        const freeReason = fields.some((field, index) => { const node = adapter.evidence(data.fields[index].sourceRef); return node?.role === 'textbox' && /причин/iu.test(node.name + ' ' + (node.placeholder ?? '')) && field.value === args.reason; });
        if (!selectedReason && !freeReason) missing.push('Не подтверждена выбранная причина возврата. Используйте точную причину из availableChoices; подробности передайте в comment.');
        if (args.comment !== undefined && !exactField(args.comment)) missing.push('Не подтверждён точный комментарий возврата.');
        if (data.selectedItems.length !== 1 || data.selectedItems[0].productTitle !== args.productTitle || data.selectedItems[0].quantity !== (args.quantity ?? 1)) missing.push('Не подтверждён выбор только нужного товара/количества для возврата.');
        for (const item of data.selectedItems) {
          if (!containsLiteral(evidenceText(adapter, item.sourceRef), item.productTitle) || adapter.evidence(item.checkedRef)?.checked !== true) missing.push('Выбранный товар возврата не подтверждён собственным отмеченным контролом.');
          const quantity = (await this.hydrateRef(adapter, item.quantityRef) ?? '').trim();
          if (quantity !== String(item.quantity) && !new RegExp(`(?:^|\\D)${item.quantity}\\s*шт`, 'iu').test(quantity)) missing.push('Не подтверждено количество возвращаемого товара.');
        }
      }
      if (kind === 'discount' && args.message !== undefined && !exactField(args.message)) missing.push('Не подтверждён точный текст запроса скидки.');
      if (kind === 'discount' && args.requestedPriceRub !== undefined && !fields.some(field => Number(field.value.replace(/[\s₽]/g, '').replace(',', '.')) === args.requestedPriceRub)) missing.push('Не подтверждена запрошенная цена скидки.');
      for (const mediaId of args.mediaIds ?? args.evidenceMediaIds ?? []) if (!adapter.uploaded.has(mediaId)) missing.push('Не подтверждена загрузка назначенного изображения.');
      if (originalOrderNumber && !containsLiteral(evidenceText(adapter, data.orderRef), originalOrderNumber)) missing.push('В форме не подтверждён исходный номер заказа.');
      if (args.productTitle && !containsLiteral(evidenceText(adapter, data.identityRef), args.productTitle)) missing.push('В форме не подтверждён точный товар.');
      const terms = [...new Set((data.termsRefs ?? []).map(ref => evidenceText(adapter, ref)).filter(Boolean))].sort();
      if (kind === 'return' && !terms.length) missing.push('Не прочитаны собственные условия/сумма/способ возврата денег.');
      facts = { targetUrl: target, orderNumber: originalOrderNumber, productTitle: args.productTitle ?? null, requested: args,
        terms, fields: fields.map(field => ({ value: field.value })).sort((a, b) => a.value.localeCompare(b.value)) };
    }
    const availableChoices = checkout ? undefined : [...adapter.current.nodes.values()].filter(node => ['radio', 'option', 'checkbox'].includes(node.role) && (node.name || node.text)).slice(0, 60).map(node => ({ label: node.name || node.text, selected: node.checked === true || node.selected === true, sourceRef: node.source }));
    if (missing.length) return { status: 'prepare_incomplete', action: kind, preview: facts, missing: [...new Set(missing)], warnings, availableChoices, adapterSummary: checkout ? undefined : data.summary, agent: result.meta };
    if (!issueToken) return { facts, adapter, button, meta: result.meta };
    return { status: 'prepared', ...(await this.confirmations.prepare(kind, facts, { args }, await this.ownerHash())), warnings, availableChoices, adapterSummary: checkout ? undefined : data.summary, agent: result.meta };
  }
  pickupMatches(expected, observed) {
    if (!observed) return false;
    const clean = value => value.toLocaleLowerCase().replace(/(?:улица|ул\.|дом|д\.)/g, '').replace(/[\s,.-]+/g, '');
    const actual = clean(observed.replace(/(?:Срок хранения|Изменить)[\s\S]*$/iu, '')); const wanted = clean(expected); const at = actual.indexOf(wanted);
    if (at < 0) return false;
    // House 70 must not silently match 701, 70A or 70/1. A changed pickup
    // point requires a new explicit preview, even on the same named street.
    return !/[\dа-яa-z/]/iu.test(actual[at + wanted.length] ?? '');
  }

  /** Only this method can dispatch a final click. Luna never receives the token
   * or a final-click tool. The caller must attest explicit owner intent, the
   * same account/plan must still match, and the attempt is fenced before I/O. */
  async confirmAction(args, cfg) {
    await this.browser.connect(cfg);
    const record = await this.confirmations.validate(args.confirmation, await this.ownerHash());
    const fresh = await this.prepareAction(record.plan.action, record.context.args, cfg, false);
    if (fresh.status === 'prepare_incomplete') throw new AppError('preview_changed', 'Не удалось повторно подтвердить план. Подготовьте новый предварительный просмотр.');
    if (digest({ action: record.plan.action, facts: fresh.facts, ownerHash: record.plan.ownerHash }) !== record.digest) throw new AppError('preview_changed', 'Сумма, состав, доставка или заполненные поля изменились. Подтверждение не применяется.');
    const { adapter, button } = fresh;
    if (!finalButtonAllowed(record.plan.action, button.target.name || button.target.text)) throw new AppError('invalid_submit_target', 'Конечная кнопка не соответствует действию.');
    await this.confirmations.attempt(record);
    const before = await adapter.page.locator('body').innerText();
    try {
      await clickObserved(adapter.currentLocator(button.snapshot, button.ref));
      await adapter.page.waitForTimeout(1800);
      const after = await adapter.page.locator('body').innerText();
      const messages = { checkout: /(?:заказ\s+оформлен|спасибо\s+за\s+заказ|заказ\s+принят)/iu, discount: /(?:запрос\s+отправлен|продавец\s+получил|скидк.*запрошена)/iu,
        return: /(?:заявка\s+на\s+возврат\s+(?:создана|оформлена|отправлена)|возврат\s+оформлен)/iu, review: /(?:отзыв\s+(?:отправлен|опубликован|на\s+модерации)|спасибо\s+за\s+отзыв)/iu };
      const match = after.match(messages[record.plan.action]);
      const verified = !!match && !before.includes(match[0]);
      const result = { verified, pageUrl: adapter.page.url(), outcomeText: match?.[0] ?? null, observedAt: new Date().toISOString(),
        instruction: verified ? 'Действие подтверждено сообщением Ozon.' : 'Результат отправки неизвестен. Проверьте заказы/возвраты/отзывы; повторно не отправляйте.' };
      await this.confirmations.finish(record, verified ? 'succeeded' : 'unknown', result);
      return { action: record.plan.action, state: verified ? 'succeeded' : 'unknown', ...result };
    } catch {
      await this.confirmations.finish(record, 'unknown', { instruction: 'Неизвестный результат после начала отправки. Повторная отправка этого плана запрещена.' });
      return { action: record.plan.action, state: 'unknown', retryAllowed: false, instruction: 'Проверьте фактический результат через заказы/возвраты/отзывы. Не повторяйте отправку.' };
    }
  }
}
