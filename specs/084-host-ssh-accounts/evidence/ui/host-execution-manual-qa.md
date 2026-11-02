# Host execution UI manual QA

- Command: `node web/src/app/verify-host-execution-ui.mjs`
- Result: 23 / 23 passed; no page errors or unexpected API routes.
- API requests were intercepted; no real SSH, production requests, commits or pushes.
- Confirmed single and batch auto installation choose the returned root account and freeze it in the reviewed plan.
- Confirmed clearing auto uses only the explicit deploy account.
- Confirmed mismatched account preflight cannot create a plan.
- Confirmed lost installation results retain the original record, allow read-only verification with another account, and do not repeat preflight, plan creation or installation apply.
- Retained prior runtime account switch, unknown reconciliation, expiry, exact review, capability authorization, member restriction and English dark-mode coverage.
- Inspected screenshots: single-manual-account-zh.png, batch-manual-account-zh.png, single-unknown-installation-zh.png, batch-unknown-installation-zh.png, runtime-review-zh.png, runtime-dark-en.png. Text, frozen login identities, unknown warnings, review controls and dark theme are readable. Long installation details use the modal's normal scroll area.
- Corrected only the test harness theme context (theme.css + data-theme) and disabled screenshot animations; product components were not modified.
