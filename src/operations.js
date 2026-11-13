import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AppError, stateDir, writePrivateJSON } from './config.js';
import { BrowserAdapter, runAdapter, evidenceText, entityId, clickObserved, readElementData } from './adapter.js';
import { scopedURL, finalButtonAllowed, assertClickAllowed } from './action-policy.js';
import { outputSchemas } from './contracts.js';
import { MediaStore, bestObservedMedia, analyzeMedia, mediaURL } from './media.js';
import { ConfirmationStore, digest } from './confirmation.js';
import { productId, searchURL, cleanPageText } from './policy.js';
import { deliveryDates } from './delivery.js';
import { normalized, containsLiteral, listEvidenceErrors, reviewSortMatches, listEntityCandidates, selectedControlLabels, semanticAttributes, renderedStars, findGalleryOverlay, videoAssetId, assetKey, galleryThumbnails, largeGalleryMedia } from './evidence.js';

const norm = value => String(value ?? '').toLocaleLowerCase().replace(/[\s\u00a0\u2009\u202f.,:;«»"'()—–-]+/g, '');
const textContains = (text, value) => value !== null && value !== undefined && norm(text).includes(norm(value));
const pricesIn = text => [...String(text).matchAll(/(\d[\d \u00a0\u2009\u202f]*)(?:[.,](\d{1,2}))?[ \u00a0\u2009\u202f]*₽/g)].map(m => Number(m[1].replace(/\s/g, '') + (m[2] ? '.' + m[2] : '')));

/** A price is not Ozon Card merely because it is the first/lowest number.
 * Require matching numeric evidence plus an explicit label or inspected visual
 * evidence. Keep the uncertainty and original source text for the caller. */
export function validateCardPrice(price, adapter) {
  const text = evidenceText(adapter, price.sourceRef) ?? '';
  const amountObserved = price.amount !== null && pricesIn(text).some(p => Math.abs(p - price.amount) < 0.005);
  const labeled = /(?:ozon|озон)\s*(?:карт|банк)|с\s+(?:ozon\s+|озон\s+)?картой/iu.test(text + ' ' + (price.basisLabel ?? ''));
  // A label copied by the model also needs to be present in its referenced text.
  const actualLabel = labeled && (/(?:ozon|озон)\s*(?:карт|банк)|с\s+(?:ozon\s+|озон\s+)?картой/iu.test(text));
  const verified = !!(price.verifiedOzonCard && amountObserved && (actualLabel || adapter.visualObserved));
  return { amount: verified ? price.amount : null, currency: 'RUB', basis: 'ozon_card', verified, sourceRef: price.sourceRef,
    evidenceType: actualLabel ? 'text' : adapter.visualObserved ? 'visual' : 'unconfirmed', displayedAmount: amountObserved ? price.amount : null,
    basisLabel: price.basisLabel, sourceText: text.slice(0, 1600) };
}

/** Runtime operations receive a single browser owner/queue from the broker.
 * Account content and cursor/confirmation receipts live only in private state. */
export class ConsumerOperations {
  constructor(browser) { this.browser = browser; this.media = new MediaStore(); this.confirmations = new ConfirmationStore(); }
  startOperation(cfg) { this.operationDeadline = Date.now() + cfg.agent.timeoutMs; }
  remaining(cfg) { return Math.max(0, (this.operationDeadline ?? Date.now() + cfg.agent.timeoutMs) - Date.now()); }
  async adapt(adapter, goal, schema, cfg) {
    // A list of fifty entities must not get fifty independent four-minute
    // budgets. One operation deadline bounds total paid work and yields a
    // resumable partial page when the caller asks for too many rows at once.
    const remaining = this.remaining(cfg);
    if (remaining < 2000) throw new AppError('operation_budget', 'Достигнут общий лимит времени операции. Продолжите с выданного курсора.');
    return runAdapter(adapter, goal, schema, { ...cfg, agent: { ...cfg.agent, timeoutMs: remaining } });
  }
  async open(url, task, cfg) {
    const page = await this.browser.beginRun(cfg); await page.bringToFront();
    const target = scopedURL(url, task.scope);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: cfg.browser.navigationTimeoutMs });
    await page.waitForTimeout(900);
    return new BrowserAdapter(page, { ...task, progressPath: path.join(stateDir(), 'receipts/adapter-active.json') }, cfg, this.media);
  }
  async extract(kind, url, goal, cfg, extra = {}) {
    const adapter = await this.open(url, { kind, scope: 'catalog', mode: 'read', ...extra }, cfg);
    return this.adapt(adapter, goal, outputSchemas[kind], cfg);
  }
  async hydrateRef(adapter, source) {
    if (!source) return null;
    const [snapshot, ref] = source.split(':');
    // Reading a current ref captures the exact DOM text/media. Historical refs
    // remain immutable and are never re-resolved against a possibly reused node.
    if (snapshot === adapter.current.id) await adapter.read(snapshot, ref);
    return evidenceText(adapter, source);
  }
  async currentProof(adapter, source) {
    // Final forms need the CURRENT native value/state, not a previously valid
    // snapshot. Read-only rebinding is allowed only for the same DOM ref and
    // semantic control identity; it never authorizes a stale click.
    if (!source) return null;
    const old = adapter.evidence(source); const ref = source.split(':')[1]; const current = adapter.current.nodes.get(ref);
    if (!current || old.role !== current.role || old.name !== current.name || (old.url ?? '') !== (current.url ?? '')) return null;
    await adapter.read(adapter.current.id, ref); return current.source;
  }
  checked(value, ref, adapter) { return textContains(evidenceText(adapter, ref), value) ? value : null; }
  async resolvedMedia(adapter, refs) {
    const items = [];
    for (const ref of refs ?? []) { await this.hydrateRef(adapter, ref); items.push(...(adapter.evidence(ref)?.media ?? [])); }
    return bestObservedMedia(items);
  }
  coverage(data, count = null) {
    return { complete: !data.hasMore && !data.missing?.length, hasMore: data.hasMore ?? null, loadedCount: count, totalCount: data.totalCount ?? null, missing: data.missing ?? [] };
  }
  async product(args, cfg) {
    const sections = args.sections ?? ['summary', 'description', 'characteristics', 'seller', 'delivery'];
    const adapter = await this.open(args.url, { kind: 'product', scope: 'catalog', mode: 'read' }, cfg);
    const subCfg = { ...cfg, adapter: { ...cfg.adapter, maxSteps: 10 } };
    // Break product detail into small adapter tasks. Asking Luna for every
    // section at once caused premature partial answers and aimless scrolling.
    const result = await this.adapt(adapter, {
      action: 'Read ONLY product summary, price, seller and delivery. Do not work on description or characteristics in this subtask.',
      requirements: 'Read exact product title/rating/review and question counts. Read Ozon Card price: if text says С банками and a green Ozon bank/card logo appears, use browser_view to inspect it. Do not confuse monthly installment/other-bank price. Scroll as needed to read seller and pickup ETA/address. Do not click cart/favorites/buy/discount. Long description is handled by a separate subtask.'
    }, outputSchemas.product_summary, subCfg);
    const { data, meta } = result;
    const price = validateCardPrice(data.priceOzonCard, adapter);
    let description = null; let descriptionParts = []; let descriptionExpanded = false; let characteristics = []; let characteristicsExpanded = false;
    const missing = [...data.missing]; const subtasks = [meta];
    if (sections.includes('description')) {
      const section = await this.adapt(adapter, { action: 'Read ONLY the complete product description and package contents.',
        steps: 'Use browser_observe search="Описание", viewportOnly=false. Read the matching parent context and exact description body ref, not a heading alone. browser_read that ref. Expand Читать полностью/Развернуть if present. Also observe/read Комплектация if present. Return separate parts with exact refs for Описание and Комплектация (no hashtags or recommendations). Do not browse other products. Characteristics are handled separately.' }, outputSchemas.description, subCfg);
      description = await this.hydrateRef(adapter, section.data.sourceRef); descriptionExpanded = section.data.expanded;
      descriptionParts = await Promise.all(section.data.parts.map(async part => ({ title: part.title, text: await this.hydrateRef(adapter, part.textRef) })));
      if (descriptionParts.length) description = descriptionParts.map(part => `${part.title}\n${part.text ?? ''}`).join('\n\n');
      missing.push(...section.data.missing); subtasks.push(section.meta);
    }
    if (sections.includes('characteristics')) {
      const section = await this.adapt(adapter, { action: 'Read ONLY all product characteristics as name/value pairs.',
        steps: 'Use browser_observe search="Характеристики", viewportOnly=false. Read its surrounding section or click the actual Характеристики tab, then expand Развернуть if present. Return every loaded name/value pair with its own row sourceRef. Do not click Добавить к сравнению. No other product sections are required.' }, outputSchemas.characteristics, subCfg);
      for (const item of section.data.items) {
        let node = item.sourceRef ? adapter.evidence(item.sourceRef) : null;
        for (let depth = 0; node && depth < 3; depth++) {
          if (textContains(node.text, item.name) && textContains(node.text, item.value) && node.text.length < 2000) { characteristics.push({ ...item, sourceRef: node.source, sourceText: node.text }); break; }
          const snapshot = adapter.snapshots.get(node.source.split(':')[0]); node = snapshot?.nodes.get(node.parentRef);
        }
      }
      const native = await adapter.page.evaluate(semanticAttributes);
      if (native.rows.length > characteristics.length) characteristics = native.rows;
      if (section.data.items.length && !characteristics.length) missing.push('Не удалось подтвердить пары названий/значений характеристик в собственных строках.');
      if (native.incomplete) missing.push(`Строк характеристик без полной семантической пары: ${native.incomplete}.`);
      characteristicsExpanded = section.data.expanded; missing.push(...section.data.missing); subtasks.push(section.meta);
    }
    return { sku: productId(args.url), url: scopedURL(args.url), title: this.checked(data.title.value, data.title.sourceRef, adapter),
      priceOzonCard: price, priceRub: price.amount, rating: this.checked(data.rating, data.ratingSourceRef, adapter),
      reviewsCount: this.checked(data.reviewsCount, data.reviewsSourceRef, adapter), questionsCount: this.checked(data.questionsCount, data.questionsSourceRef, adapter),
      description, descriptionParts, descriptionExpanded, characteristics, characteristicsExpanded,
      seller: data.seller, delivery: data.delivery, variant: data.variant.value, media: await this.resolvedMedia(adapter, data.mediaRefs),
      coverage: { complete: !missing.length, missing, requestedSections: sections }, observedAt: new Date().toISOString(), agent: { ...meta, subtasks } };
  }
  async filters(args, cfg) {
    const { data, adapter, meta } = await this.extract('filters', searchURL(args.query), {
      action: 'Discover category-specific search filters and actual sort options. Open sort dropdown to read options, then close it without choosing if possible.',
      expand: args.expand ?? true,
      requirements: 'Report actual filter group names/options including price range, brand and delivery deadlines (tomorrow/3/7/12 days if offered), and category-specific attributes. Exclude installments, one-ruble promotions, credit, sale/subscription marketing groups. Expand relevant collapsed groups and show-more options within reasonable bounds. Mark missing/truncated groups honestly.'
    }, cfg, { initialViewportOnly: false });
    return { query: args.query, url: adapter.page.url(), groups: data.groups.filter(g => !/рассроч|за\s*1\s*[₽р]|премиум|premium|кредит/iu.test(g.name)),
      sorts: data.sorts, coverage: this.coverage(data, data.groups.length), observedAt: new Date().toISOString(), agent: meta };
  }
  async applyFilters(adapter, args, cfg) {
    const desired = { sort: args.sort ?? 'relevance', minPriceRub: args.minPriceRub ?? null, maxPriceRub: args.maxPriceRub ?? null, brands: args.brands ?? [], deliveryWithinDays: args.deliveryWithinDays ?? null, filters: args.filters ?? [] };
    const stages = [];
    if (desired.sort !== 'relevance') stages.push({ name: 'Сортировка', desired: desired.sort, search: 'Популяр', instructions: 'Open actual sort dropdown and choose this ordering. Popular=Популярные, cheaper=Дешевле, expensive=Дороже, rating=С высоким рейтингом, new=Новинки. Finish only after the CLOSED selected control shows requested label.' });
    if (desired.minPriceRub !== null) stages.push({ name: 'Цена', desired: { min: desired.minPriceRub, max: desired.maxPriceRub }, search: 'Цена', instructions: 'Fill actual minimum/maximum price fields and Apply if required. No financial promotions.' });
    for (const brand of desired.brands) stages.push({ name: 'Бренд', desired: brand, search: 'Бренд', instructions: 'Select this exact brand checkbox. If not shown, expand Показать всё for brand and/or use brand search input. Scroll/read actual options. Do not substitute another brand or a product title.' });
    if (desired.deliveryWithinDays !== null) stages.push({ name: 'Срок доставки', desired: desired.deliveryWithinDays, search: 'Достав', instructions: 'Select offered delivery deadline no later than requested days, e.g. До 7 дней. Click actual choice. If unavailable report missing; never broaden.' });
    for (const filter of desired.filters) stages.push({ name: filter.name, desired: filter.values, search: filter.name, instructions: 'Choose only the exact offered category attribute values, preserving previous filters.' });
    const data = { applied: [], sort: null, sortSourceRef: null, missing: [] }; const subtasks = [];
    adapter.task.allowedLabels = [...desired.brands, ...desired.filters.flatMap(filter => filter.values)];
    // One facet per small-model task: a combined sort+brand+delivery request
    // previously caused an immediate unfinished answer with no UI actions.
    for (const stage of stages) {
      adapter.task.initialSearch = stage.search;
      const result = await this.adapt(adapter, { action: 'Apply THIS ONE search facet only, then stop.', facet: stage.name, desired: stage.desired, instructions: stage.instructions,
        requirements: 'Do one concrete UI step at a time; use actual observed refs. Keep earlier filters. Confirm Apply/Готово if required, close any facet popover when done. Return applied values with checked-state proof. sortSourceRef must be the actual selected CLOSED sort control, not an unchosen option. Other unrelated filters are not part of this task.' }, outputSchemas.filter_apply, { ...cfg, adapter: { ...cfg.adapter, maxSteps: 10 } });
      data.applied.push(...result.data.applied); data.missing.push(...result.data.missing); subtasks.push(result.meta);
      if (stage.name === 'Сортировка') { data.sort = result.data.sort; data.sortSourceRef = result.data.sortSourceRef; }
      await adapter.page.keyboard.press('Escape');
    }
    adapter.task.initialSearch = null;
    if (desired.sort !== 'relevance') {
      const patterns = { popular: /популяр/iu, cheaper: /деш[её]в|возрастан/iu, expensive: /дорог|дороже|убыван/iu, rating: /рейтинг|высокой оцен/iu, new: /нов/iu };
      const proof = evidenceText(adapter, data.sortSourceRef) ?? '';
      if (!patterns[desired.sort]?.test(data.sort ?? '') || !containsLiteral(proof, data.sort) || proof.length > 150) data.missing.push('Сортировка не подтверждена в собственном выбранном контроле.');
    }
    await adapter.observe({ viewportOnly: false });
    const checked = [...adapter.current.nodes.values()].filter(node => node.checked === true || node.selected === true).map(node => node.name || node.text);
    checked.push(...await adapter.page.evaluate(selectedControlLabels));
    // A model-written "applied" array is insufficient: each requested brand
    // or category option needs observed checked/selected UI state.
    const chips = [...adapter.current.nodes.values()].filter(node => node.role === 'button' && /:/.test(node.name)).map(node => node.name);
    const deadlineLabel = chips.find(label => /^Доставк[а-я]*\s*:/iu.test(label))?.split(':').slice(1).join(':').trim();
    const deadlineDays = deadlineLabel?.match(/до\s+(\d+)\s+дн/iu)?.[1];
    const actualDeadline = deadlineDays ? Number(deadlineDays) : deliveryDates(deadlineLabel).days;
    data.deliveryWithinDays = desired.deliveryWithinDays !== null && actualDeadline !== null && actualDeadline <= desired.deliveryWithinDays ? actualDeadline : null;
    const equalChoice = (label, value) => label.split(/[\n,;]/).some(part => normalized(part) === normalized(value));
    const selected = (name, value) => checked.some(label => equalChoice(label, value)) || chips.some(label => containsLiteral(label.split(':')[0], name) && equalChoice(label.slice(label.indexOf(':') + 1), value));
    // Ozon can implement a brand as a category route rather than checkbox:
    // the active "Бренд: Centek" removal chip is then the native proof.
    for (const value of desired.brands) if (!selected('Бренд', value)) data.missing.push(`Не подтверждён выбранный фильтр: ${value}`);
    for (const filter of desired.filters) for (const value of filter.values) if (!selected(filter.name, value)) data.missing.push(`Не подтверждён выбранный фильтр: ${filter.name}: ${value}`);
    return { data, adapter, meta: { subtasks } };
  }
  async priceForProduct(url, cfg) {
    // Card lists often omit the bank label. Verify the price in an isolated
    // product tab rather than assuming the cheapest list number is card price.
    // Keeping a second tab preserves the immutable search/review ref registry.
    await this.browser.connect(cfg);
    if (!this.pricePage || this.pricePage.isClosed()) {
      for (const page of this.browser.context.pages()) if (page.url().startsWith('https://www.ozon.ru/') && await page.evaluate(() => window.name).catch(() => '') === 'ozon-mcp-price-verification') { this.pricePage = page; break; }
      if (!this.pricePage || this.pricePage.isClosed()) this.pricePage = await this.browser.context.newPage();
      this.priceFocus = await this.browser.context.newCDPSession(this.pricePage);
      await this.priceFocus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await this.pricePage.setViewportSize({ width: cfg.browser.viewportWidth, height: cfg.browser.viewportHeight });
    }
    await this.pricePage.bringToFront();
    await this.pricePage.goto(scopedURL(url), { waitUntil: 'domcontentloaded', timeout: cfg.browser.navigationTimeoutMs });
    await this.pricePage.evaluate(() => { window.name = 'ozon-mcp-price-verification'; });
    await this.pricePage.getByRole('button', { name: /С банками|Ozon Карт|Озон Карт/i }).first().waitFor({ state: 'attached', timeout: 10000 }).catch(() => {});
    if (productId(this.pricePage.url()) !== productId(url)) return { amount: null, verified: false, basis: 'ozon_card', reason: 'variant_changed' };
    const adapter = new BrowserAdapter(this.pricePage, { kind: 'product', scope: 'catalog', mode: 'read', initialSearch: 'С банками', progressPath: path.join(stateDir(), 'receipts/price-active.json') }, cfg, this.media);
    const result = await this.adapt(adapter, { action: 'Read ONLY Ozon Card price and pickup delivery label for this exact SKU. No other research.',
      requirements: 'Read bank-price control. Use browser_view for green price/bank logos; if needed open С банками to inspect conditions. Ozon Bank/Card must be included. Also read the actual pickup arrival label (not retention/payment dates), with exact deliverySourceRef; if not observed return null. Do not buy, add to cart, subscribe or open a bank account. Price needs exact sourceRef and confirmed card basis.' }, outputSchemas.price_only, { ...cfg, adapter: { ...cfg.adapter, maxSteps: 8 } });
    const deliveryLabel = containsLiteral(evidenceText(adapter, result.data.deliverySourceRef), result.data.deliveryLabel) ? result.data.deliveryLabel : null;
    return { ...validateCardPrice(result.data.priceOzonCard, adapter), delivery: deliveryDates(deliveryLabel), sourceUrl: this.pricePage.url().split('?')[0], observedAt: new Date().toISOString(), verification: result.meta, missing: result.data.missing };
  }
  async selectReviewSort(adapter, wanted, cfg) {
    await adapter.observe({ viewportOnly: false });
    const labels = () => [...adapter.current.nodes.values()].filter(n => n.text.length < 90 && n.text.trim() && !n.text.includes('\n'));
    const targetPattern = wanted.startsWith('rating_') ? /^(?:сначала )?(?:с )?(?:низкой|высокой) оценкой$/iu : /^(?:сначала )?(?:новые(?: и полезные)?|полезные)$/iu;
    // The observed Ozon control toggles high/low on a second click. Always
    // click the actual control (at most twice), then verify its new label.
    for (let i = 0; i < 2; i++) {
      const candidates = labels().filter(n => targetPattern.test(n.text));
      if (candidates.length !== 1 || wanted === 'new' && /полезные/iu.test(candidates[0].text)) break;
      await adapter.act('browser_click', { sourceRef: candidates[0].source, purpose: 'Apply exact requested review ordering' });
      const selected = labels().find(n => targetPattern.test(n.text));
      if (selected && reviewSortMatches(selected.text, wanted)) return { verified: true, label: selected.text, sourceRef: selected.source, url: adapter.page.url() };
    }
    const desiredLabel = { rating_asc: 'с низкой оценкой (одна звезда первой)', rating_desc: 'с высокой оценкой (пять звёзд первыми)', new: 'сначала новые, строго по дате', useful: 'полезные (допускается вариант новые и полезные)' }[wanted];
    const result = await this.adapt(adapter, { action: 'Set ONLY this review ordering, then stop.', desiredLabel,
      requirements: 'Do not extract reviews. Use actual sort controls. Rating control can toggle high/low on a repeated click. Do not confuse high with low. If only combined новые и полезные exists, strict newest-first is unavailable: return missing. Do not invent query parameters.' }, outputSchemas.review_sort, { ...cfg, adapter: { ...cfg.adapter, maxSteps: 6 } });
    return { verified: !result.data.missing.length && reviewSortMatches(result.data.label, wanted) && containsLiteral(evidenceText(adapter, result.data.sourceRef), result.data.label),
      label: result.data.label, missing: result.data.missing, sourceRef: result.data.sourceRef, url: adapter.page.url() };
  }
  async expandEntity(region, page) {
    // These exact read-only labels only disclose existing text/comments. They
    // never match vote/reply/send controls and need no generated widget class.
    const opened = new Set();
    for (let i = 0; i < 5; i++) {
      const controls = [region.getByText(/^(?:Читать полностью|Развернуть|Показать полностью)$/iu),
        region.getByRole('button', { name: /^(?:Ещ[её]\s+\d+\s+ответ[а-я]*|\d+\s+комментари[а-я]*|Показать\s+(?:все\s+)?ответ[а-я]*)$/iu })];
      let changed = false;
      for (const control of controls) {
        if (await control.count() !== 1 || !await control.isVisible()) continue;
        const label = (await control.innerText()).trim(); if (opened.has(label)) continue;
        try { await clickObserved(control); opened.add(label); await page.waitForTimeout(500); changed = true; } catch { /* The adapter may inspect an unavailable disclosure. */ }
      }
      if (!changed) break;
    }
    return [...opened];
  }
  async list(kind, args, cfg) {
    const base = scopedURL(args.url).replace(/\/(?:reviews|questions)\/?(?:\?.*)?$/, '/');
    const u = new URL(base); u.search = ''; u.hash = ''; u.pathname = u.pathname.replace(/\/?$/, '/') + (kind === 'reviews' ? 'reviews/' : 'questions/');
    const cursor = args.cursor ? await this.readCursor(args.cursor, kind, args.url) : null;
    const sort = args.sort ?? 'useful';
    if (cursor && cursor.sort !== sort) throw new AppError('invalid_cursor', 'Курсор относится к другой сортировке.');
    const seen = new Set(cursor?.seen ?? []); const limit = args.limit ?? 15;
    const adapter = await this.open(cursor?.resumeUrl ?? u.href, { kind, scope: 'catalog', mode: 'read', initialViewportOnly: false }, cfg);
    const appliedSort = kind === 'reviews' ? await this.selectReviewSort(adapter, sort, cfg) : null;
    if (appliedSort && !appliedSort.verified) return { status: 'sort_unavailable', requestedSort: sort, actualSort: appliedSort.label, items: [], nextCursor: null,
      coverage: { complete: false, missing: appliedSort.missing ?? ['Не подтверждена запрошенная сортировка.'] } };
    if (cursor?.scrollY) { await adapter.page.evaluate(y => window.scrollTo(0, y), cursor.scrollY); await adapter.page.waitForTimeout(600); }
    const seenSeeds = new Set(cursor?.seenSeeds ?? []); const items = []; const missing = []; const subtasks = [];
    let candidates = []; let totalCount = null;
    for (let pass = 0; pass < 4; pass++) {
      await adapter.observe({ viewportOnly: false }); candidates = listEntityCandidates(adapter, kind);
      const heading = [...adapter.current.nodes.values()].find(n => kind === 'reviews' ? /Отзывы о товаре\s+\d/iu.test(n.name) : /^Вопросы\s*\d/iu.test(n.name));
      totalCount = Number(heading?.name.match(/\d+/)?.[0]) || null;
      if (candidates.some(candidate => !seenSeeds.has(entityId('seed', candidate.seed)))) break;
      await adapter.page.evaluate(() => window.scrollBy(0, innerHeight * 1.5)); await adapter.page.waitForTimeout(800);
    }
    if (!candidates.length) {
      const plan = await this.adapt(adapter, { action: 'Identify full separate entity parent refs ONLY, without extracting their individual fields.', kind, wanted: limit,
        requirements: 'Each ref must contain exactly one question with all its answers, or one review with all its comments. Choose the full parent, not author/date/body child. Do not post/vote. Scroll to find the list if needed.' }, outputSchemas.entity_plan, { ...cfg, adapter: { ...cfg.adapter, maxSteps: 7 } });
      candidates = plan.data.entityRefs.map(ref => ({ ...adapter.evidence(ref), seed: adapter.evidence(ref).text.slice(0, 250) })); totalCount = plan.data.totalCount; missing.push(...plan.data.missing);
    }
    const bound = [];
    // A fragment snapshot can replace Playwright's page-wide ref registry.
    // Bind each discovered DOM object BEFORE taking any fragments. Temporary
    // private attributes are removed below; no Ozon class/selector is retained.
    for (const candidate of candidates.filter(candidate => !seenSeeds.has(entityId('seed', candidate.seed))).slice(0, limit)) {
      const token = randomBytes(12).toString('hex'); let handle = await adapter.page.getByRef(candidate.source.split(':')[1]).elementHandle();
      if (!handle) continue;
      if (kind === 'reviews') {
        // AX can omit an initially neutral wrapper. Existing comments are
        // inserted as siblings of the dated review, inside that DOM wrapper.
        // Bind the largest ancestor containing exactly one review-help marker.
        const complete = (await handle.evaluateHandle(el => {
          let root = el; let parent = el.parentElement;
          while (parent) { const text = parent.innerText ?? ''; if (text.length > 18000 || (text.match(/Вам помог этот отзыв/giu) ?? []).length !== 1 || /Рейтинг формируется на основе/iu.test(text)) break; root = parent; parent = parent.parentElement; }
          return root;
        })).asElement();
        await handle.dispose(); handle = complete;
      }
      await handle.evaluate((el, token) => el.setAttribute('data-ozon-mcp-region', token), token);
      bound.push({ ...candidate, handle, regionLocator: adapter.page.locator(`[data-ozon-mcp-region="${token}"]`) });
    }
    try { for (const candidate of bound) {
      const seed = entityId('seed', candidate.seed); if (seenSeeds.has(seed)) continue;
      const regionLocator = candidate.regionLocator;
      const isolated = new BrowserAdapter(adapter.page, { kind, scope: 'catalog', mode: 'read', regionLocator, initialViewportOnly: false,
        progressPath: path.join(stateDir(), 'receipts/adapter-active.json') }, cfg, this.media);
      isolated.task.headerDate = candidate.text.match(/(?:измен[её]н\s+)?\d{1,2}\s+[а-я]+\s+20\d{2}/iu)?.[0] ?? null;
      let rejected = 0;
      isolated.task.validateFinish = data => {
        const errors = listEvidenceErrors(kind, data.items, ref => evidenceText(isolated, ref));
        if (data.items.length !== 1) errors.push('Return exactly this ONE entity. The full parent is the root of this isolated tree.');
        if (kind === 'reviews' && !isolated.task.renderedRating && !isolated.visualObserved && data.items.some(row => row.stars === null)) errors.push('Use browser_view: it shows only this review, including its actual star icons.');
        return errors.length && rejected++ < 2 ? errors : [];
      };
      try {
        await regionLocator.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
        isolated.task.disclosuresOpened = await this.expandEntity(regionLocator, adapter.page);
        if (kind === 'reviews') isolated.task.renderedRating = await regionLocator.evaluate(renderedStars);
        // One small model task per row eliminates cross-row joins. Screenshot
        // is cropped to this same region, tying visual stars to the right author.
        const result = await this.adapt(isolated, { action: kind === 'questions' ? 'Read THIS ONE question and ALL its answers.' : 'Read THIS ONE complete review with all details.',
          renderedRating: isolated.task.renderedRating ?? null, observedHeaderDate: isolated.task.headerDate,
          disclosuresAlreadyOpened: isolated.task.disclosuresOpened,
          requirements: 'Use sourceRef=s1:e0 (or latest snapshot e0): this is the full exact entity root. Return items length ONE. textRef is its body CHILD, never e0/product title/author. Host already opened listed disclosure controls: DO NOT click them again (it would collapse text). Read all existing answers/comments including their full refs. browser_read retrieves link text without clicking it. If host renderedRating is known use those stars; otherwise browser_view shows this entity only. Never navigate, vote, reply or submit. No other entities to browse.' }, outputSchemas[kind], { ...cfg, adapter: { ...cfg.adapter, maxSteps: 10 } });
        subtasks.push(result.meta); missing.push(...result.data.missing);
        for (const raw of result.data.items.slice(0, 1)) {
          const item = await this.hydrateListItem(kind, raw, isolated, args.url);
          if (!item) { missing.push('Одна сущность пропущена: текст/автор/ответы не подтверждены в её собственном блоке.'); continue; }
          seenSeeds.add(seed); if (seen.has(item.id)) continue; seen.add(item.id); items.push(item);
        }
      } catch (error) { if (['site_blocked', 'login_required', 'provider_error'].includes(error.code)) throw error; missing.push('Не завершено чтение одной сущности; повторная отправка каких-либо действий не выполнялась.'); }
      finally { await candidate.handle.evaluate(el => el.removeAttribute('data-ozon-mcp-region')).catch(() => {}); await candidate.handle.dispose(); }
      if (this.remaining(cfg) < 2000) { missing.push('Достигнут лимит времени страницы; продолжите с nextCursor.'); break; }
      if (items.length >= limit) break;
    } } finally {
      for (const candidate of bound) { await candidate.handle.evaluate(el => el.removeAttribute('data-ozon-mcp-region')).catch(() => {}); await candidate.handle.dispose().catch(() => {}); }
    }
    const hasMore = totalCount === null || seenSeeds.size < totalCount;
    const stalled = hasMore && items.length === 0;
    if (stalled) missing.push('Не удалось продвинуть страницу к новым сущностям; повторяющийся курсор не выдан.');
    const nextCursor = hasMore && !stalled ? await this.saveCursor(kind, args.url, { seen: [...seen], seenSeeds: [...seenSeeds], sort, resumeUrl: adapter.page.url(), scrollY: await adapter.page.evaluate(() => scrollY) }) : null;
    return { url: args.url, requestedSort: kind === 'reviews' ? sort : null, sort: appliedSort?.label ?? null, items, nextCursor, paginationStalled: stalled,
      coverage: { complete: !hasMore && !missing.length, pageComplete: items.length >= Math.min(limit, (totalCount ?? limit) - (cursor?.seenSeeds?.length ?? 0)), hasMore, loadedCount: items.length, totalCount, missing },
      observedAt: new Date().toISOString(), agent: { ...cfg.models.browserAgent, subtasks } };
  }

  async hydrateListItem(kind, raw, adapter, url) {
    const rawText = await this.hydrateRef(adapter, raw.sourceRef); const text = await this.hydrateRef(adapter, raw.textRef);
    if (kind === 'questions') for (const answer of raw.answers) { await this.hydrateRef(adapter, answer.sourceRef); await this.hydrateRef(adapter, answer.textRef); }
    if (listEvidenceErrors(kind, [raw], ref => evidenceText(adapter, ref)).length) return null;
    const date = adapter.task.headerDate ?? raw.date;
    const id = entityId(kind === 'reviews' ? 'review' : 'question', productId(url) ?? url, raw.author ?? '', date ?? '', text ?? rawText ?? '');
    if (kind === 'reviews') {
      const item = { id, author: raw.author, date, stars: adapter.task.renderedRating?.stars ?? (raw.starsSource === 'visual' && !adapter.visualObserved ? null : raw.stars),
      starsEvidence: adapter.task.renderedRating?.evidence ?? raw.starsSource, variant: raw.variant, text, pros: await this.hydrateRef(adapter, raw.prosRef), cons: await this.hydrateRef(adapter, raw.consRef), fullTextExpanded: raw.fullTextExpanded,
      media: bestObservedMedia([...(adapter.evidence(raw.sourceRef).media ?? []), ...await this.resolvedMedia(adapter, raw.mediaRefs)]).filter(media => media.displayedWidth >= 70 && media.displayedHeight >= 70),
      replies: await Promise.all(raw.replyRefs.map(ref => this.hydrateRef(adapter, ref))), helpfulCount: raw.helpfulCount,
      unhelpfulCount: raw.unhelpfulCount, verifiedPurchase: raw.verifiedPurchase, rawText, sourceRef: raw.sourceRef };
      await writePrivateJSON(path.join(stateDir(), 'entities', id + '.json'), { id, productUrl: url, listUrl: adapter.page.url(), author: item.author, date: item.date, text: item.text,
        scrollY: await adapter.page.evaluate(() => scrollY), observedAt: new Date().toISOString() });
      return item;
    }
    return { id, author: raw.author, date, text, rawText, sourceRef: raw.sourceRef, answersExpanded: raw.answersExpanded,
      answers: await Promise.all(raw.answers.map(async (answer, i) => ({ id: entityId('answer', id, String(i), answer.author ?? '', answer.date ?? ''),
        author: answer.author, date: answer.date, isSeller: answer.isSeller, text: await this.hydrateRef(adapter, answer.textRef), sourceRef: answer.sourceRef }))) };
  }
  async gallery(args, cfg) {
    let record = null;
    if (args.reviewId) {
      if (!/^review_[a-f0-9]{20}$/.test(args.reviewId)) throw new AppError('unknown_review', 'Сначала получите reviewId через ozon_reviews.');
      try { record = JSON.parse(await fs.readFile(path.join(stateDir(), 'entities', args.reviewId + '.json'), 'utf8')); } catch { throw new AppError('unknown_review', 'Отзыв ещё не прочитан. Сначала вызовите ozon_reviews.'); }
    }
    const adapter = await this.open(record?.listUrl ?? args.url, { kind: 'media', scope: 'catalog', mode: 'read' }, cfg);
    const videoSources = new Set();
    // Observe ONLY media response metadata generated by this real viewer.
    // Never read response bodies/authorization headers or call hidden APIs.
    // MSE players use blob: in DOM; their actual MP4/HLS/DASH sources remain
    // available here for the consumer instead of substituting poster images.
    const onMedia = response => {
      if (videoSources.size >= 50) return;
      const type = response.headers()['content-type'] ?? ''; const url = response.url();
      if (/\.(?:ts|m4s|aac)(?:\?|$)/iu.test(url) || !/video\/|mpegurl|dash\+xml/iu.test(type) && !/\.(?:mp4|m3u8|mpd)(?:\?|$)/iu.test(url)) return;
      try { videoSources.add(mediaURL(url)); } catch { /* Non-Ozon sources never become download capabilities. */ }
    };
    adapter.page.on('response', onMedia); let cleanupRoot = null; let nativeRoot = null; let reviewAssetCount = null;
    const reviewMediaKeys = new Set(); const reviewVideoAssets = new Set(); let ownMedia = []; let ownSource = null;
    try {
    if (record) {
      await adapter.page.evaluate(y => window.scrollTo(0, y), record.scrollY ?? 0); await adapter.page.waitForTimeout(500);
      let found = null;
      for (let pass = 0; pass < 8; pass++) {
        await adapter.observe({ viewportOnly: false });
        const matches = listEntityCandidates(adapter, 'reviews').filter(row => (!record.author || containsLiteral(row.text, record.author)) && (!record.date || containsLiteral(row.text, record.date)) && (!record.text || containsLiteral(row.text, record.text.slice(0, 100))));
        found = matches.length === 1 ? matches[0] : null;
        if (found) break;
        await adapter.page.evaluate(() => window.scrollBy(0, innerHeight * 1.5)); await adapter.page.waitForTimeout(600);
      }
      if (!found) throw new AppError('review_not_loaded', 'Этот точный отзыв не найден в загруженном списке; другой отзыв не подставляется.');
      const controls = adapter.page.getByRef(found.source.split(':')[1]).getByRole('button', { name: 'Открыть галерею', exact: true });
      if (!await controls.count()) return { reviewId: args.reviewId, media: [], coverage: { complete: true, missing: [], note: 'У этого отзыва нет наблюдаемой галереи.' } };
      reviewAssetCount = await controls.count();
      const own = await adapter.page.getByRef(found.source.split(':')[1]).evaluate(readElementData);
      ownMedia = own.media.filter(media => media.displayedWidth >= 70 && media.displayedHeight >= 70); ownSource = found.source;
      for (const media of own.media) for (const source of [media.src, ...(media.srcset ?? '').split(',').map(part => part.trim().split(/\s+/)[0])].filter(Boolean)) {
        reviewMediaKeys.add(assetKey(source)); const videoId = videoAssetId(source); if (videoId) reviewVideoAssets.add(videoId);
      }
      await clickObserved(controls.first()); await adapter.page.waitForTimeout(700);
      nativeRoot = (await adapter.page.evaluateHandle(findGalleryOverlay, { author: record.author })).asElement();
      if (nativeRoot) {
        const token = randomBytes(12).toString('hex'); await nativeRoot.evaluate((el, token) => el.setAttribute('data-ozon-mcp-gallery', token), token);
        adapter.task.regionLocator = adapter.page.locator(`[data-ozon-mcp-gallery="${token}"]`);
      }
    }
    const { data, meta } = await this.adapt(adapter, { action: record ? 'The host already opened the exact requested REVIEW gallery. Identify its structure ONLY; do not click underlying product photos.' : 'Open the full-screen PRODUCT image gallery, then identify its structure. Do NOT inspect every thumbnail yourself.',
      requestedReview: record ? { author: record.author, date: record.date, text: record.text } : null,
      reviewInstructions: record ? 'Use overlayRootRef for the fullscreen FIXED review viewer, even though it contains Другие фото и видео пользователей BELOW the main viewer. The host excludes that other-user section. The LARGE main photo can be an unnamed CSS background with no AX ref: mainImageRef=null is fine; host reads it. expectedCount counts ONLY thumbnails/photos of this exact author/review (not heading 11 other-user media). Never navigate Next slide to another review.' : null,
      requirements: (record ? 'The exact review viewer is ALREADY open. Do not click its thumbnail again. ' : 'Click main product image. ') + 'Use observed overlayRootRef for the current fullscreen gallery. Return galleryRef and actual thumbnail refs inside it, mainImageRef (null is fine for CSS backgrounds) and videoRefs. All refs from latest snapshot. Do not select other users media or product cards beneath. Host reads all real main sources. expectedCount counts only this gallery/review assets. hasMoreThumbnails if undiscovered.' }, outputSchemas.gallery_plan, cfg);
    const items = []; const warnings = [...data.missing]; const missing = record && nativeRoot ? [] : [...data.missing]; let visited = 0;
    if (record) items.push(...await this.media.register(ownMedia.map(media => ({ ...media, mediaPurpose: videoAssetId(media.src) ? 'video_poster' : 'review_image' })), { pageUrl: record.listUrl, sourceRef: ownSource }));
    if (!data.galleryRef || data.galleryRef.split(':')[0] !== adapter.current.id) return { url: args.url, media: [], galleryOpened: false, coverage: { complete: false, missing: [...missing, 'Галерея не привязана к актуальному снимку.'] }, agent: meta };
    const [rootSnapshot, rootRef] = data.galleryRef.split(':'); const root = await adapter.currentLocator(rootSnapshot, rootRef).elementHandle();
    cleanupRoot = root;
    if (!root) throw new AppError('gallery_changed', 'Галерея изменилась. Повторите чтение.');
    const safe = await root.evaluate(el => {
      const box = el.getBoundingClientRect(); let fixed = !!el.closest('[role="dialog"],[aria-modal="true"]');
      for (let node = el; node; node = node.parentElement) { const b = node.getBoundingClientRect(); if (getComputedStyle(node).position === 'fixed' && b.width >= innerWidth * 0.7 && b.height >= innerHeight * 0.7) fixed = true; }
      const dangerous = [...el.querySelectorAll('button,[role="button"]')].some(button => /в корзин|оформить заказ|купить сейчас/iu.test(button.innerText));
      return fixed && box.width >= innerWidth * 0.7 && box.height >= innerHeight * 0.7 && !dangerous && !!el.querySelector('img,video');
    });
    if (!safe) throw new AppError('invalid_gallery_region', 'Область не подтверждена как отдельная полноэкранная галерея.');
    await root.evaluate(async el => { for (const video of el.querySelectorAll('video')) { const box = video.getBoundingClientRect(); if (box.width * box.height < 120000) continue; video.muted = true; await Promise.race([video.play().catch(() => {}), new Promise(resolve => setTimeout(resolve, 2000))]); } });
    await adapter.page.waitForTimeout(600);
    const openedKeys = new Set(); const mainVideoAssets = new Set(reviewVideoAssets);
    const readGallery = async () => {
      const details = await root.evaluate(readElementData);
      if (!record) items.push(...await this.media.register(details.media, { pageUrl: adapter.page.url(), sourceRef: data.galleryRef }));
      // A review viewer may include a strip of OTHER buyers' media. Never
      // attribute their pictures to the requested review merely by adjacency.
      if (record && !containsLiteral(details.text, record.author)) return;
      const large = (await root.evaluate(largeGalleryMedia)).filter(media => !record || media.tag !== 'img' || reviewMediaKeys.has(assetKey(media.src)));
      for (const media of large) for (const source of [media.src, media.poster]) { const id = videoAssetId(source); if (id && (!record || reviewVideoAssets.has(id))) mainVideoAssets.add(id); }
      const opened = await this.media.register(large, { pageUrl: adapter.page.url(), sourceRef: data.galleryRef, galleryView: 'opened_as_main' });
      for (const item of opened) { items.push(item); openedKeys.add(assetKey(item.url)); }
    };
    await readGallery();
    const visitedKeys = new Set(); let discovered = 0;
    // The model discovers the gallery boundary; code enumerates ALL actual
    // thumbnails inside it. This prevents a 9-ref model answer from silently
    // skipping four of thirteen photos. Re-scan once for lazy-loaded thumbs.
    for (let pass = 0; pass < 2; pass++) {
      const candidates = await root.evaluate(galleryThumbnails); discovered = Math.max(discovered, candidates.length);
      for (const candidate of candidates) {
        if (visitedKeys.has(candidate.key) || visited >= (args.limit ?? 100)) continue;
        const handle = (await root.evaluateHandle((el, index) => el.querySelectorAll('*')[index], candidate.index)).asElement(); if (!handle) continue;
        try {
          const same = await handle.evaluate((el, source) => (el.currentSrc || el.src || getComputedStyle(el).backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1]) === source, candidate.fingerprint);
          if (!same) { missing.push('Миниатюра изменилась до нажатия; повторное использование запрещено.'); continue; }
          const target = await handle.evaluate(el => { const control = el.closest('a,button,[role="button"]') ?? el; return { name: control.getAttribute('aria-label') || control.getAttribute('title') || '', text: control.innerText || '', href: control.href ?? null, role: 'generic', hasMedia: true, inGallery: true }; });
          assertClickAllowed(target, adapter.task);
          await clickObserved(handle);
          // A new large source can appear before its pixels finish loading.
          // Wait for this exact asset, not just a fixed delay or any old image.
          await root.evaluate((el, pathname) => new Promise(resolve => {
            const start = performance.now(); const key = u => { try { return new URL(u).pathname.replace(/\/(?:wc|w|c|s)\d+(?:_\d+)?\//g, '/'); } catch { return ''; } };
            const check = () => { const ready = [...el.querySelectorAll('img,video')].some(img => { const b = img.getBoundingClientRect(); return (b.width >= 200 || b.height >= 200) && key(img.currentSrc || img.src) === pathname && (img.complete || img.readyState >= 2); });
              if (ready || performance.now() - start > 5000) resolve(); else setTimeout(check, 100); }; check();
          }), candidate.key);
          await readGallery(); visited++; visitedKeys.add(candidate.key);
        } catch { missing.push('Не удалось безопасно открыть одну из миниатюр.'); }
        finally { await handle.dispose(); }
      }
    }
    const cached = await adapter.page.evaluate(() => performance.getEntriesByType('resource').map(entry => entry.name).filter(url => /\.(?:mp4|m3u8|mpd)(?:\?|$)/iu.test(url)));
    for (const source of cached) { try { videoSources.add(mediaURL(source)); } catch { /* Only actual CDN observations qualify. */ } }
    items.push(...await this.media.register([...videoSources].filter(src => mainVideoAssets.has(videoAssetId(src))).map(src => ({ tag: 'video', src })), { pageUrl: adapter.page.url(), sourceRef: data.galleryRef, resolution: 'observed_stream' }));
    if (await root.evaluate(el => !!el.querySelector('video')) && !items.some(item => item.kind === 'video')) missing.push('Видео видно в плеере, но его исходный поток не наблюдался. Обложка не считается полным видео.');
    const media = bestObservedMedia(items); const expected = record ? Math.max(reviewAssetCount ?? 0, discovered) : data.expectedCount ?? discovered;
    if (!media.length) missing.push('Не найден подтверждённый источник основного фото/видео. Другие отзывы не подставляются.');
    const fullSizeImages = media.filter(item => item.galleryView === 'opened_as_main');
    const unopened = media.filter(item => item.kind === 'image' && item.mediaPurpose !== 'video_poster' && !openedKeys.has(assetKey(item.url))).length;
    if (unopened) missing.push(`Полный размер не подтверждён для ${unopened} изображений.`);
    const complete = !missing.length && visited >= discovered && media.length >= expected && !unopened;
    return { url: record?.productUrl ?? args.url, reviewId: args.reviewId ?? null, media, galleryOpened: true, expectedCount: expected, visitedThumbnails: visited, openedMainCount: fullSizeImages.length,
      coverage: { complete, hasMore: !complete, loadedCount: media.length, missing }, warnings, observedAt: new Date().toISOString(), agent: meta };
    } finally {
      adapter.page.off('response', onMedia);
      await nativeRoot?.evaluate(el => el.removeAttribute('data-ozon-mcp-gallery')).catch(() => {});
      await cleanupRoot?.dispose().catch(() => {}); await nativeRoot?.dispose().catch(() => {});
    }
  }
  async getMedia(args, cfg) {
    await this.browser.connect(cfg); const result = await this.media.get(args.mediaId, this.browser.context);
    if (args.analyze) result.analysis = await analyzeMedia(result, args.question, cfg);
    return result;
  }
  async saveCursor(kind, url, value) {
    const id = randomBytes(24).toString('base64url');
    await writePrivateJSON(path.join(stateDir(), 'cursors', id + '.json'), { kind, url, ...value, createdAt: new Date().toISOString() }); return id;
  }
  async readCursor(id, kind, url) {
    if (!/^[\w-]{32}$/.test(id)) throw new AppError('invalid_cursor', 'Неверный курсор страницы.');
    let record; try { record = JSON.parse(await fs.readFile(path.join(stateDir(), 'cursors', id + '.json'), 'utf8')); } catch { throw new AppError('invalid_cursor', 'Курсор страницы не найден.'); }
    if (record.kind !== kind || record.url !== url) throw new AppError('invalid_cursor', 'Курсор относится к другому товару или разделу.');
    return record;
  }
  async ownerHash() {
    const uid = (await this.browser.context.cookies('https://www.ozon.ru/')).find(c => c.name === '__Secure-user-id');
    if (!uid || !/^\d+$/.test(uid.value) || Number(uid.value) <= 0) throw new AppError('login_required', 'Требуется авторизованный аккаунт.');
    return createHash('sha256').update(uid.value).digest('hex');
  }
}
