import { z } from 'zod';

// Public input contracts stay small and purpose-specific. Nullable fields mean
// "not observed", never a license for Luna to guess a missing price or date.
const ref = z.string().regex(/^s\d+:(?:[a-z]\d+)?e\d+$/).nullable();
const url = z.string().max(3000);
const short = z.string().max(1000);
const number = z.number().nonnegative().nullable();
export const sortSchema = z.enum(['relevance', 'popular', 'cheaper', 'expensive', 'rating', 'new']);
export const filterInput = z.object({ name: z.string().max(150), values: z.array(z.string().max(200)).min(1).max(20) }).strict();
export const searchInput = z.object({
  query: z.string().trim().min(2).max(1500), limit: z.number().int().min(1).max(30).optional(),
  sort: sortSchema.optional(), minPriceRub: z.number().nonnegative().optional(), maxPriceRub: z.number().positive().max(100000000).optional(),
  brands: z.array(z.string().max(100)).max(15).optional(), deliveryWithinDays: z.number().int().min(0).max(365).optional(),
  filters: z.array(filterInput).max(20).optional()
}).strict();
export const productInput = z.object({ url, sections: z.array(z.enum(['summary', 'description', 'characteristics', 'seller', 'delivery'])).optional() }).strict();
export const listInput = z.object({ url, scope: z.enum(['current', 'all']).default('current'), sort: z.enum(['useful', 'new', 'rating_asc', 'rating_desc']).optional(), limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(100).optional() }).strict();

const sourcedString = z.object({ value: short.nullable(), sourceRef: ref }).strict();
const price = z.object({ amount: number, sourceRef: ref, basisLabel: short.nullable(), verifiedOzonCard: z.boolean() }).strict();
const summary = {
  title: sourcedString, priceOzonCard: price, rating: number, reviewsCount: number, questionsCount: number,
  ratingSourceRef: ref, reviewsSourceRef: ref, questionsSourceRef: ref
};
const delivery = z.object({ method: z.enum(['pickup', 'courier', 'unknown']), label: short.nullable(), earliestDate: z.string().nullable(), latestDate: z.string().nullable(), pickupPoint: short.nullable(), sourceRef: ref }).strict();
const attribute = z.object({ name: short, value: short, sourceRef: ref }).strict();
const mediaRefs = z.array(z.string().regex(/^s\d+:(?:[a-z]\d+)?e\d+$/)).max(150);
const checkoutItem = z.object({ title: short, sku: short.nullable(), quantity: z.number().int().positive(), quantitySourceRef: ref, priceRub: number, sourceRef: ref }).strict();

/** Extraction schemas request refs for long content, not model-copied prose.
 * The adapter hydrates those refs from the live page so reviews/descriptions
 * cannot be silently summarized or cut to the model's output token budget. */
export const outputSchemas = {
  review_scope: z.object({ active: z.boolean().nullable(), sourceRef: ref, missing: z.array(short).max(10) }).strict(),
  variants: z.object({ groups: z.array(z.object({ label: short, sourceRef: ref, options: z.array(z.object({ label: short, sourceRef: ref }).strict()).max(60) }).strict()).max(12), missing: z.array(short).max(20) }).strict(),
  checkout_items: z.object({ items: z.array(checkoutItem).max(50), missing: z.array(short).max(10) }).strict(),
  review_sort: z.object({ label: short.nullable(), sourceRef: ref, missing: z.array(short).max(10) }).strict(),
  entity_plan: z.object({ entityRefs: mediaRefs, totalCount: number, hasMore: z.boolean(), missing: z.array(short).max(10) }).strict(),
  price_only: z.object({ priceOzonCard: price, deliveryLabel: short.nullable(), deliverySourceRef: ref, missing: z.array(short).max(10) }).strict(),
  collection_form: z.object({ nameRef: ref, descriptionRef: ref, visibilityRef: ref, saveButtonRef: ref, saveButtonLabel: short.nullable(), missing: z.array(short).max(15) }).strict(),
  collection_selection: z.object({ selected: z.array(z.object({ url, sourceRef: ref, checkedRef: ref }).strict()).max(100), saveButtonRef: ref, missing: z.array(short).max(15) }).strict(),
  product_summary: z.object({ ...summary, seller: z.object({ name: short.nullable(), url: url.nullable(), rating: number, sourceRef: ref }).strict(), delivery, variant: sourcedString, mediaRefs, missing: z.array(short).max(20) }).strict(),
  description: z.object({ sourceRef: ref, parts: z.array(z.object({ title: short, textRef: ref }).strict()).max(20), expanded: z.boolean(), missing: z.array(short).max(20) }).strict(),
  characteristics: z.object({ items: z.array(attribute).max(150), expanded: z.boolean(), missing: z.array(short).max(20) }).strict(),
  search_cards: z.object({ items: z.array(z.object({ title: short, url, sourceRef: ref, priceOzonCard: price,
    rating: number, ratingKind: z.enum(['product', 'store', 'unknown']), reviewsCount: number, questionsCount: number,
    deliveryLabel: short.nullable(), deliverySourceRef: ref, stockLabel: short.nullable(), badges: z.array(short).max(15), sellerName: short.nullable(), mediaRefs
  }).strict()).max(30), hasMore: z.boolean(), missing: z.array(short).max(20) }).strict(),
  product: z.object({ ...summary, descriptionRef: ref, descriptionExpanded: z.boolean(), characteristics: z.array(attribute).max(150), characteristicsExpanded: z.boolean(),
    seller: z.object({ name: short.nullable(), url: url.nullable(), rating: number, sourceRef: ref }).strict(), delivery,
    variant: sourcedString, mediaRefs, missing: z.array(short).max(20)
  }).strict(),
  filters: z.object({ groups: z.array(z.object({ name: short, type: z.enum(['choice', 'range', 'delivery', 'brand', 'boolean', 'unknown']), sourceRef: ref,
    options: z.array(z.object({ label: short, selected: z.boolean(), sourceRef: ref }).strict()).max(100), min: number, max: number, expanded: z.boolean()
  }).strict()).max(80), sorts: z.array(z.object({ label: short, sourceRef: ref, selected: z.boolean() }).strict()).max(15), missing: z.array(short).max(20) }).strict(),
  filter_apply: z.object({ applied: z.array(z.object({ name: short, values: z.array(short).max(20), sourceRef: ref }).strict()).max(30), sort: short.nullable(), sortSourceRef: ref, missing: z.array(short).max(20) }).strict(),
  reviews: z.object({ items: z.array(z.object({ sourceRef: ref, author: short.nullable(), date: short.nullable(), stars: z.number().int().min(1).max(5).nullable(),
    starsSource: z.enum(['text', 'visual', 'unknown']), variant: short.nullable(), textRef: ref, prosRef: ref, consRef: ref, fullTextExpanded: z.boolean(),
    mediaRefs, replyRefs: mediaRefs, helpfulCount: number, unhelpfulCount: number, verifiedPurchase: z.boolean().nullable()
  }).strict()).max(50), sortLabel: short.nullable(), totalCount: number, hasMore: z.boolean(), missing: z.array(short).max(20) }).strict(),
  questions: z.object({ items: z.array(z.object({ sourceRef: ref, author: short.nullable(), date: short.nullable(), textRef: ref,
    answers: z.array(z.object({ sourceRef: ref, textRef: ref, author: short.nullable(), date: short.nullable(), isSeller: z.boolean().nullable() }).strict()).max(100),
    answersExpanded: z.boolean()
  }).strict()).max(50), totalCount: number, hasMore: z.boolean(), missing: z.array(short).max(20) }).strict(),
  media: z.object({ mediaRefs, galleryOpened: z.boolean(), hasMore: z.boolean(), missing: z.array(short).max(20) }).strict(),
  gallery_plan: z.object({ galleryRef: ref, thumbnailRefs: mediaRefs, mainImageRef: ref, videoRefs: mediaRefs, expectedCount: number, hasMoreThumbnails: z.boolean(), missing: z.array(short).max(20) }).strict(),
  orders: z.object({ appliedStatus: z.enum(['active', 'completed', 'all', 'unknown']), statusSourceRef: ref, items: z.array(z.object({ sourceRef: ref, orderNumber: short.nullable(), status: short.nullable(), deliveryLabel: short.nullable(), date: short.nullable(),
    products: z.array(z.object({ title: short, url: url.nullable(), quantity: number }).strict()).max(100), detailUrl: url.nullable(), canReturn: z.boolean(), canReview: z.boolean()
  }).strict()).max(100), hasMore: z.boolean(), missing: z.array(short).max(20) }).strict(),
  collections: z.object({ items: z.array(z.object({ name: short, description: short.nullable(), url: url.nullable(), sourceRef: ref, isPublic: z.boolean().nullable(), productCount: number, coverRef: ref }).strict()).max(100), hasMore: z.boolean(), missing: z.array(short).max(20) }).strict(),
  cart: z.object({ items: z.array(z.object({ sourceRef: ref, title: short, url: url.nullable(), quantity: number, selected: z.boolean(), priceOzonCard: price, deliveryLabel: short.nullable() }).strict()).max(100), total: number, missing: z.array(short).max(20) }).strict(),
  checkout: z.object({ items: z.array(checkoutItem).max(50),
    totalRub: number, totalSourceRef: ref, paymentLabel: short.nullable(), paymentSourceRef: ref,
    delivery: delivery.extend({ dateSourceRef: ref, pickupSourceRef: ref }).strict(), finalButtonRef: ref,
    finalButtonLabel: short.nullable(), additionalCharges: z.array(short).max(20), additionalChargeRefs: mediaRefs, missing: z.array(short).max(20)
  }).strict(),
  form: z.object({ target: short, summary: short, identityRef: ref, orderRef: ref,
    selectedItems: z.array(z.object({ productTitle: short, quantity: z.number().int().positive(), sourceRef: ref, checkedRef: ref, quantityRef: ref }).strict()).max(30), termsRefs: mediaRefs,
    fields: z.array(z.object({ name: short, sourceRef: ref }).strict()).max(100), finalButtonRef: ref, finalButtonLabel: short.nullable(), missing: z.array(short).max(20) }).strict(),
  mutation: z.object({ applied: z.boolean(), targetSku: short.nullable(), destination: short.nullable(), quantity: number, quantityRef: ref, membershipRef: ref,
    evidenceRef: ref, outcomeText: short.nullable(), missing: z.array(short).max(20) }).strict()
};

export const confirmationInput = z.object({ token: z.string().min(30).max(100), digest: z.string().length(64), confirmed: z.literal(true) }).strict();

/** Mutation requests are explicit intent, separate from preview/read. Finals
 * use prepared tokens; reversible actions require apply=true from the caller. */
export const consumerInputs = {
  product_variants: z.object({ url }).strict(),
  product_variant_select: z.object({ url, variantId: z.string().regex(/^variant_[a-f0-9]{20}$/) }).strict(),
  search_filters: z.object({ query: z.string().min(2).max(500), expand: z.boolean().optional() }).strict(),
  product_media: z.object({ url, limit: z.number().int().min(1).max(100).optional() }).strict(),
  review_media: z.object({ reviewId: z.string().regex(/^review_[a-f0-9]{20}$/), limit: z.number().int().min(1).max(100).optional() }).strict(),
  media_get: z.object({ mediaId: z.string().max(100), analyze: z.boolean().optional(), question: z.string().max(2000).optional() }).strict(),
  media_import: z.object({ path: z.string().max(2000) }).strict(),
  reviews: listInput,
  questions: z.object({ url, limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(100).optional() }).strict(),
  orders: z.object({ status: z.enum(['active', 'completed', 'all']).optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(100).optional() }).strict(),
  order_detail: z.object({ url: url.optional(), orderId: z.string().regex(/^order_[a-f0-9]{20}$/).optional() }).strict().refine(value => !!value.url !== !!value.orderId, 'Provide url OR orderId'),
  collections: z.object({ kind: z.enum(['all','collection','wishlist']).default('all'), name: z.string().min(1).max(100).optional() }).strict(),
  shopping_list: z.object({name:z.string().min(1).max(100),description:z.string().max(2000).optional(),productUrls:z.array(url).min(1).max(100),apply:z.boolean().default(false)}).strict(),
  collection_create: z.object({ name: z.string().min(1).max(100), description: z.string().max(2000).optional(), isPublic: z.boolean(), coverMediaId: z.string().max(100).optional(), productUrls: z.array(url).max(100).default([]), apply: z.boolean().default(false) }).strict(),
  favorite: z.object({ url, target: z.enum(['favorites', 'wishlist', 'collection']), collectionName: z.string().max(100).optional(), listName: z.string().max(100).optional(), apply: z.boolean().default(false) }).strict(),
  cart: z.object({}).strict(),
  cart_add: z.object({ url, quantity: z.number().int().min(1).max(20).default(1), apply: z.boolean().default(false) }).strict(),
  checkout_prepare: z.object({ url, quantity: z.number().int().min(1).max(20).default(1), maxTotalRub: z.number().positive().optional(), pickupPoint: z.string().max(300).optional(), payment: z.enum(['ozon_installment', 'ozon_bank']).optional() }).strict(),
  discount_prepare: z.object({ url, requestedPriceRub: z.number().positive().optional(), message: z.string().max(2000).optional() }).strict(),
  return_prepare: z.object({ orderUrl: url, productTitle: z.string().min(1).max(500), quantity: z.number().int().min(1).max(20).default(1), reason: z.string().min(1).max(500), comment: z.string().max(3000).optional(), evidenceMediaIds: z.array(z.string()).max(10).optional() }).strict(),
  review_prepare: z.object({ orderUrl: url, productTitle: z.string().min(1).max(500), stars: z.number().int().min(1).max(5), text: z.string().min(1).max(10000), pros: z.string().max(5000).optional(), cons: z.string().max(5000).optional(), mediaIds: z.array(z.string()).max(10).optional() }).strict(),
  action_confirm: z.object({ confirmation: confirmationInput }).strict(),
  action_status: z.object({ token: z.string().min(30).max(100) }).strict()
};
