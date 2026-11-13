# Security and privacy

This experimental client controls a real signed-in consumer account. Run it only
on a trusted desktop, with trusted MCP clients and a dedicated Chrome profile.
The loopback CDP endpoint has browser privileges; do not expose or forward it.
The private broker socket and session state are not a multi-user security boundary.

API keys, Chrome profiles, exported cookies, uploads, action plans and account
artifacts stay outside the repository. Never attach them to public issues.
The configured model provider receives workflow-specific visible page content,
which may include order information and delivery addresses. Choose a provider
and retention policy appropriate for that data. Do not share a signed-in profile.

Final actions require an observed preview, expiring token/digest and explicit
caller confirmation. `confirmed: true` is the caller's assertion of authorization;
it is not an independent user approval UI or authentication factor. Unknown
outcomes are fenced against blind retry. Check actual account state before any
manual reconciliation. Do not test real purchases, refunds or publications.

Report vulnerabilities privately via GitHub private vulnerability reporting when
available, or the repository owner's GitHub profile contact options. Do not post
credentials, payment data, session files or exploitable account details in issues.
Only the latest source version receives fixes; no response-time guarantee is made.
