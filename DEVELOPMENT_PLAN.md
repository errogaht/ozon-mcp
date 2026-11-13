# Consumer workflows expansion — 2026-11-13

## Owner contract

Build MCP tools for the owner's product-research and purchasing workflows.
Luna is a small browser adapter: narrowly scoped tasks, compact accessibility
trees, stable observed refs, structured evidence and deterministic validation.
Do not depend on generated Ozon CSS classes or undocumented shopping APIs.

Search needs Ozon Card price, rating, review/question counts, delivery, sort
(popular/cheap), available category-specific filters and their current options.
Support price, brand, delivery deadline and category attributes. Exclude lending,
one-ruble promotions and similar marketing filters from suggested defaults.

Product needs complete expanded description, characteristics, seller/store,
pickup/delivery estimate, all accessible gallery photos/video, reviews as separate
entities (full text, stars, author/date/variant, media, pros/cons, replies where
shown), questions and all loaded answers, pagination with honest completeness.

Actions: discount request, cart, favorites/wishlist, collections (name, description,
cover, visibility, products), checkout preview and later explicit purchase,
active/completed orders, return preparation/submission, review preparation/publication.

Preferences: Ozon Card price; Ozon installment payment; pickup the user-configured pickup point,
changeable by explicit request. Do not substitute pay-after-delivery or another
bank/payment silently. Save private preferences outside Git; no account IDs here.

## Development safety boundary

No order submission, discount requests, return submission or review publication
in live tests. The owner said NOT to buy test products. Reversible navigation,
form inspection and pre-submit preview are authorized. Prefer fixture tests for
mutations; a live mutation, if needed to verify a user-visible tool, must be
narrow/reversible and recorded/restored, without modifying unrelated cart entries.

Final actions require prepare → preview with exact facts → one-use token/digest →
explicit caller confirmation → revalidation → at-most-once attempt → reconciliation.
Unknown provider/site outcome fences the token and forbids blind replays.
Confirmation is a deliberate caller attestation, not proof of human intent;
MCP metadata/instructions must require an actual owner request.

## Implementation order / acceptance

1. Browser adapter: compact refs, limited semantic actions, evidence registry,
   task schemas, bounded loops, no final action available to a reader task.
2. Search: enriched entities, Ozon Card basis, sorting and filter discovery/apply.
3. Product: expanded sections, media listing/read, reviews and questions pagination.
4. Favorites/collections/cart: observed target, exact parameters, verified outcome.
5. Orders and checkout/returns/reviews: read/prepare, confirmation gates, fixtures
   for submission and truthful limits on live verification.
6. MCP schemas/resources, regression/negative-control tests, live safe acceptance,
   docs/checkpoints and committed/integrated code. Keep actual tested features
   separate from implemented but unexercised irreversible operations.

The goal remains active until requested scope is handled. Record concrete
browser blockers and continue independent work rather than inventing page data.
