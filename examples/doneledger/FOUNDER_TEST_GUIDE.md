# DoneLedger Founder Test Guide

This guide validates the public product without spending Solari credits. Use the prepared reviewer account supplied privately by the project owner.

## Fast path - 10 minutes, zero Solari credits

1. Open the public URL and inspect the marketing landing page.
2. Open **Explore Sample Evidence** while logged out. Confirm `Synthetic Sample`, `17/20`, three exceptions and no live permission or lifecycle proof.
3. Log in with the reviewer account. Refresh once and confirm the session and display name persist.
4. Open **New Verification** and download the founder test kit.
5. Upload `01-success-2-of-2.csv`, then choose **Run Safe Fixture**. Expect `2/2` verified and no Solari or Dolibarr call.
6. Upload `02-exceptions-3-of-5.csv`, then choose **Run Safe Fixture**. Expect `3/5` verified, one `FIELD_MISMATCH` and one `RECORD_MISSING`.
7. Upload `03-invalid-total.csv`. Expect an immediate validation error: gross must equal net plus tax.
8. Upload `04-missing-column.csv`. Expect an immediate header validation error.
9. From a retained report, test Share, open the link logged out, Revoke, then confirm the old link is unavailable. Create another fixture and test Delete.
10. Log out, confirm the private app redirects to login, then log back in and confirm retained runs return.

## Full acceptance

- Landing: positioning, workflow, security, FAQ and GitHub links work at desktop and 390 px.
- Authentication: signup/login/logout/session persistence work; no password appears in page text, browser storage or reports.
- Import: exact headers, valid dates, three-letter currency, totals, unique job IDs, 25-row limit and 200 KB client limit are enforced before any live request.
- Fixture mode: calls only `/api/demo-runs`; every report says synthetic and never claims ERP permissions, browser cleanup or customer evidence.
- Report: hero, filters, rows, detail inspector and downloaded JSON agree on run ID, mode and totals.
- Sharing: public link works without owner controls; revoke and delete make it unavailable.
- Ownership: a second account gets 404 for the first account's report and mutations.
- Failure states: unavailable history shows an alert and em dashes, never false zero metrics.
- Accessibility: no horizontal overflow at 390 px; menu focus, Escape, backdrop, forms, filters and delete dialog work with the keyboard.

## Live credit gate - do not run during ordinary review

Live mode is intentionally disabled on the public proof deployment. A live canary is allowed only with a fresh private Solari key, the exact allowlisted Dolibarr origin, a dedicated read-only ERP account, an access code, a recorded credit balance and explicit authorization for one submission. Never retry automatically or manually. The accepted artifact must prove denied create/payment permissions and successful browser/sandbox cleanup.

## Evidence hygiene

Record timestamps, screenshots, HTTP statuses and run IDs. Never record passwords, cookies, API keys, access codes or full share tokens.
