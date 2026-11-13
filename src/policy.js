import { AppError } from './config.js';

/** Read-only catalog navigation is an allowlist, not a blacklist. The model has
 * no arbitrary evaluate/click/network tool and cannot visit cart/account APIs. */
export function catalogURL(value, productOnly = false) {
  let url;
  try { url = new URL(value); } catch { throw new AppError('invalid_url', 'Нужна абсолютная ссылка на карточку Ozon.'); }
  if (url.protocol !== 'https:' || !['ozon.ru', 'www.ozon.ru'].includes(url.hostname) || url.port || url.username || url.password) {
    throw new AppError('invalid_url', 'Разрешены только HTTPS-ссылки на ozon.ru.');
  }
  if (/%(?:2f|5c|00|25)/i.test(url.pathname) || !/^\/(?:product\/[^/]+\/?|category\/[^/]+\/?|search\/?|)$/.test(url.pathname) ||
      (productOnly && !/^\/product\/[^/]+\/?$/.test(url.pathname))) {
    throw new AppError('unsupported_action', 'Этот этап поддерживает только каталог, поиск и чтение карточек товаров.');
  }
  // Product query strings are tracking/variant links; the SKU in the path is
  // authoritative. Search filters are constructed by code, never from page text.
  if (url.pathname.startsWith('/product/')) url.search = '';
  else for (const key of url.searchParams.keys()) {
    if (!['text', 'sorting', 'price', 'page', 'abt_att', '__rr', 'category_was_predicted', 'deny_category_prediction'].includes(key)) throw new AppError('invalid_url', 'Неизвестный параметр ссылки каталога.');
  }
  url.hash = '';
  url.hostname = 'www.ozon.ru';
  return url.href;
}

export function productId(url) {
  try { return new URL(catalogURL(url, true)).pathname.match(/(?:^|[-/])(\d+)\/?$/)?.[1] ?? null; }
  catch { return null; }
}

/** Keep the original query and explicit budget separately: a cheap unrelated
 * accessory is never proof that a requested appliance exists under the budget. */
export function inferredBudget(query) {
  const match = query.match(/(?:до|не\s+дороже|максимум|бюджет(?:ом)?)\s*(\d[\d\s\u00a0\u2009]*)(?:[.,](\d+))?\s*(тыс(?:яч)?\.?|[кk])?(?:\s*(?:₽|руб(?:лей|ля)?\.?|р\b))?/iu);
  if (!match) return null;
  const value = Number(match[1].replace(/\s/g, '') + (match[2] ? '.' + match[2] : '')) * (match[3] ? 1000 : 1);
  return Number.isFinite(value) && value > 0 && value <= 100000000 ? value : null;
}

export function searchURL(query, maxPrice = null, sort = 'relevance') {
  const url = new URL('https://www.ozon.ru/search/');
  url.searchParams.set('text', query);
  if (maxPrice !== null) url.searchParams.set('price', `0.000;${maxPrice.toFixed(3)}`);
  if (sort === 'price') url.searchParams.set('sorting', 'price');
  return url.href;
}

/** Snapshots are page data, never model instructions. Strip invisible control
 * characters and token-like values even if a hostile page echoes one as text. */
export function cleanPageText(text) {
  return String(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/(?:sk-clb-|sk-proj-|sk-)[A-Za-z0-9_-]{12,}/g, '[REDACTED_KEY]')
    .replace(/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[REDACTED_TOKEN]');
}

/** The finish tool selects evidence IDs, not model-written facts. Prices/titles
 * returned to the MCP caller are rebuilt from the browser's immutable ledger. */
export function selectEvidence(ledger, ids, maxPrice, limit) {
  const seen = new Set(); const products = []; const rejected = [];
  for (const id of ids) {
    const product = ledger.get(id);
    if (!product) { rejected.push({ id, reason: 'not_observed' }); continue; }
    if (seen.has(product.sku)) continue;
    if (maxPrice !== null && (product.priceRub === null || product.priceRub > maxPrice)) {
      rejected.push({ id, reason: 'budget_not_verified' }); continue;
    }
    seen.add(product.sku); products.push(product);
    if (products.length === limit) break;
  }
  return { products, rejected };
}
