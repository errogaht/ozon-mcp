# Ozon consumer MCP

Read PROJECT_STATUS.md before continuing. This project is not enrolled in the
Markdown Task Tracker; do not enable it automatically.

## Boundaries and invariants

- The owner authorized consumer workflows on 2026-11-13: catalog/filter discovery,
  product/media/reviews/questions, favorites/collections, cart, checkout preview,
  order history and return/review preparation. Read DEVELOPMENT_PLAN.md.
- During development NEVER submit an order, return, review or discount request.
  The owner explicitly revoked the tentative offer to buy cheap test products.
  Final-action tools require a single-use, expiring confirmation bound to an
  observed preview and exact requested action. Never auto-confirm during tests.
- Use the working dedicated Chrome profile from config/defaults.json. Never copy
  the owner's ordinary Chrome/Yandex profile or account cookies into the repo.
- Launch visible stock Chrome independently and attach over loopback CDP with an
  explicit nonzero port. Port 0 sets navigator.webdriver=true and caused an Ozon
  challenge here. Do not add stealth patches, fingerprint overrides, headless mode,
  or --enable-automation. Keep Chrome open when MCP/CLI clients exit.
- The private state directory is ~/.local/share/ozon-mcp (0700); credentials and
  storage-state backups are outside Git, mode 0600. Never log their contents.
- MCP uses stdio. stdout must contain only MCP protocol messages in serve mode.
  Browser ownership and serialization belong to a local Unix-socket service.
- Send the internal model bounded accessibility YAML and observed evidence,
  never raw HTML, cookies, tokens, payment credentials or arbitrary script execution.
  Account/order/address information is allowed only for the requested workflow,
  must be redacted from public artifacts and kept out of ordinary service logs.
- Browser action policy is enforced by code, not only by prompt. Use task-specific
  route/action allowlists. No generic externally exposed browser or network tool.
  Mutation tools need exact targets, observed preconditions and postcondition checks.
- Prices mean Ozon Card prices only. Unknown basis stays unknown, not the first
  unrelated/struck-through/installment price. Preferred payment is Ozon installment;
  preferred delivery is pickup, the user-configured pickup point. Do not silently choose alternatives.
- Model/reasoning selection is configured by purpose. Read overrides at the start
  of each run; active runs retain their original configuration snapshot.
- Document code intent and boundaries in English comments. Test fixtures describe
  scenarios and must never contain real account data.

## Verification

Run `npm test` and `npm run check`. Test live authentication via `node src/cli.js status`
and `auth-save`; search via `node src/cli.js search 'мобильные кондиционеры до 30000 руб'`.
Use an MCP SDK client for an actual initialize/listTools/callTool acceptance check.
Record bounded evidence in PROJECT_STATUS.md; do not claim a successful search
from a models-list probe or a mocked agent. Keep agent failure/partial/no-results
distinct from successful results. No purchases as part of verification.
