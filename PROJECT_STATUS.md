# Ozon Consumer MCP — public release status

Version 0.2.0. Public source repository: https://github.com/errogaht/ozon-mcp.
This project is not enrolled in Markdown Task Tracker; do not enroll automatically.

25 consumer tools are implemented. See README.md for configuration, supported
workflows and confirmation semantics. Linux/Node.js 22+/visible Chrome are the
verified environment. Model selection and reasoning are configured by purpose.

Verification before publication: 36 fixture tests and JavaScript syntax checks.
Live read-only verification covered search/sort/dynamic filters, Ozon Card prices,
product text/characteristics, galleries/review media, individual reviews/questions,
order summaries/details, collections/cart reads, and checkout preview/revalidation.
No actual order, discount request, return or review was submitted. Mutation and
final-action handlers are fixture-tested; their live submission is unverified.

Limits: partial data stays explicit, unavailable prices remain null, media uses
largest observed URLs rather than guessed originals. Unknown final outcomes are
fenced against retry and require manual reconciliation. A confirmation flag is a
caller attestation, not an independent human authentication mechanism.

The public Git history starts from a sanitized source snapshot. Earlier private
workstation history is retained locally and must never be pushed. Credentials,
Chrome profiles, account artifacts and delivery preferences remain outside Git.
