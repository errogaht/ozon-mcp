import YAML from 'yaml';
import { cleanPageText, catalogURL, productId } from './policy.js';

/** Preserve the semantic YAML tree while removing noisy wrapper nodes, page
 * chrome and tracking URLs. No selectors depend on Ozon's generated CSS names. */
export function compactTree(raw, maxChars) {
  const prune = value => {
    if (Array.isArray(value)) return value.flatMap(item => {
      const result = prune(item); return result === null ? [] : Array.isArray(result) ? result : [result];
    });
    if (typeof value === 'string') {
      if (/^(?:banner|contentinfo)\b/.test(value)) return null;
      return cleanPageText(value).replace(/ \[(?:ref=[^\]]+|cursor=pointer)\]/g, '');
    }
    if (!value || typeof value !== 'object') return value;
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const k = key.replace(/ \[(?:ref=[^\]]+|cursor=pointer)\]/g, '');
      if (/^(?:banner|contentinfo)\b/.test(k)) continue;
      if (k === '/url') {
        try { out[k] = catalogURL(new URL(String(child), 'https://www.ozon.ru').href); } catch { /* Advertising and account destinations never enter the model context. */ }
        continue;
      }
      const result = prune(child);
      if (/^generic(?: \[aria-hidden\])?$/.test(k)) return result;
      if (result !== null) out[cleanPageText(k)] = result;
    }
    return Object.keys(out).length ? out : null;
  };
  let tree;
  try { tree = YAML.stringify(prune(YAML.parse(raw)), { lineWidth: 140 }); }
  catch { tree = '- text: "Дерево пока недоступно; используйте наблюдаемые карточки товаров."\n'; }
  const lines = tree.split('\n'); let chars = 0; const kept = [];
  for (const line of lines) { if (chars + line.length + 1 > maxChars - 140) break; kept.push(line); chars += line.length + 1; }
  const truncated = kept.length < lines.length;
  // A bounded excerpt remains readable even when cut inside a deep subtree.
  return { yaml: kept.join('\n'), truncated, sourceChars: raw.length, chars };
}

/** Browser-side extraction associates each product link with its smallest
 * visible ancestors containing a price and a single SKU. Multi-product containers
 * are rejected, preventing a neighboring card's price from being attributed. */
export function readCardsInPage() {
  const visible = el => {
    const box = el.getBoundingClientRect(); const style = getComputedStyle(el);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const skuOf = href => { try { return new URL(href, location.href).pathname.match(/^\/product\/[^/]*?(\d+)\/?$/)?.[1]; } catch { return null; } };
  const collected = new Map();
  for (const a of document.querySelectorAll('a[href*="/product/"]')) {
    if (!visible(a)) continue;
    const sku = skuOf(a.href); if (!sku) continue;
    if (collected.size >= 24 && !collected.has(sku)) continue;
    const title = (a.innerText || a.getAttribute('aria-label') || '').trim();
    if (!title || title.length < 5 || title.includes('₽') || /^(в корзину|купить|подробнее|распродажа|вау-цены|цена что надо)$/i.test(title)) continue;
    let card = a; let text = ''; let cardElement = null;
    for (let i = 0; card && i < 8; i++, card = card.parentElement) {
      const current = card.innerText?.trim() || '';
      if (current.length > 2500) break;
      const skus = new Set([...card.querySelectorAll('a[href*="/product/"]')].map(el => skuOf(el.href)).filter(Boolean));
      if (skus.size > 1) break;
      if (/\d[\d\s\u2009\u00a0]*\s*₽/.test(current)) { text = current; cardElement = card; }
    }
    // Image links can contain sale badges. Prefer the descriptive title link,
    // rather than the biggest ancestor text, when the same SKU appears twice.
    if (!text || title.length <= (collected.get(sku)?.title.length ?? 0)) continue;
    const media = cardElement ? [...cardElement.querySelectorAll('img')].map(img => ({ tag: 'img', src: img.currentSrc || img.src, srcset: img.getAttribute('srcset'), alt: img.alt, width: img.naturalWidth, height: img.naturalHeight })) : [];
    collected.set(sku, { sku, url: a.href, title: title.slice(0, 500), cardText: text.slice(0, 2200), media });
  }
  return [...collected.values()];
}

/** Parse only literal facts present in a card. A store's rating must not be
 * presented as a product rating, and a delivery label is kept verbatim. */
export function visibleCardFacts(text) {
  const count = word => { const m = text.match(new RegExp('(\\d[\\d \\u00a0\\u2009\\u202f]*)\\s*' + word, 'iu')); return m ? Number(m[1].replace(/\s/g, '')) : null; };
  const ratingMatch = text.match(/(?:^|\n)([0-5][.,]\d)(?:\s*\n|$)/);
  const store = /рейтинг\s+магазина/iu.test(text);
  const rating = ratingMatch ? Number(ratingMatch[1].replace(',', '.')) : null;
  const delivery = text.split('\n').map(s => s.trim()).find(s => /^(?:(?:доставим|доставка|получите)\s+)?(?:сегодня|завтра|послезавтра|(?:с\s+)?\d{1,2}(?:\s*[–—-]\s*\d{1,2})?\s+(?:янв|фев|мар|апр|ма[йя]|июн|июл|авг|сен|окт|ноя|дек))/iu.test(s)) ?? null;
  return { rating: store ? null : rating, ratingKind: rating === null ? 'unknown' : store ? 'store' : 'product', storeRating: store ? rating : null,
    reviewsCount: count('отзыв'), questionsCount: count('вопрос'), deliveryLabel: delivery, stockLabel: text.match(/\d[\d \u00a0\u2009]*\s*ед\s+осталось/iu)?.[0] ?? null };
}

/** Multiple price labels are kept as evidence. The first rendered card price
 * may require an Ozon card/subscription; never call it an unconditional checkout
 * total and never silently substitute an old struck-through price. */
export function cardEvidence(raw, id, sourceUrl, now = new Date().toISOString()) {
  const url = catalogURL(raw.url, true); const sku = productId(url);
  if (!sku) return null;
  const text = cleanPageText(raw.cardText);
  const prices = [...text.matchAll(/(\d[\d \u00a0\u2009\u202f]*)(?:[.,](\d{1,2}))?[ \u00a0\u2009\u202f]*₽/gu)].map(m => ({
    rub: Number(m[1].replace(/\s/g, '') + (m[2] ? '.' + m[2] : '')), label: m[0].trim()
  })).filter(p => Number.isFinite(p.rub) && p.rub > 0);
  return {
    evidenceId: id, sku, title: cleanPageText(raw.title), url,
    priceRub: prices[0]?.rub ?? null, priceText: prices[0]?.label ?? null,
    priceBasis: /с\s+(?:ozon\s+)?картой|ozon\s+банк/i.test(text) ? 'ozon_card' : 'displayed_conditions_not_verified',
    observedPrices: prices.slice(0, 4), cardText: text,
    sourceUrl, observedAt: now
  };
}
