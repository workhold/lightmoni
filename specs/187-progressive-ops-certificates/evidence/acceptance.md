# Acceptance evidence — 2026-11-19

## Behavior verified

- The isolated browser fixture delayed `/ops/overview`: application and website configuration appeared first with Loading status; dependent actions were disabled. When overview arrived, status updated in place.
- With inventory held, a host-filtered application list did not show unverified matches. A late response from the previous page did not replace the current website page.
- A failed overview retained application configuration, displayed Failed to load, and recovered through Retry.
- Local PEM chain and private key file selection caused no write before Save. The certificate resource POST received both values; public fixture resources omitted them. Website HTTPS settings selected a platform certificate for one binding and an uploaded certificate for another; save and reopen retained both IDs.
- Browser report: [ui-report.json](ui-report.json). The fixture generated its test key pair in a temporary directory and removed it after the run.

## Checks

- `node web/src/app/ops/verify-progressive-certificates-ui.mjs` — pass, 7 browser scenarios, no page errors.
- `node --import tsx --test test/platform-api.test.ts` from `runtime/` — 19 pass, 1 environment-gated skip, 0 fail; includes config projection/admin/redaction and certificate/website contracts.
- `node --import tsx --test --test-name-pattern='uploaded material is preserved' test/platform-cloud-certificates.test.ts` from `runtime/` — pass.
- `npm --prefix web run typecheck`, `npm --prefix runtime run typecheck`, `npm --prefix web run build`, `git diff --check` — pass.

The older `verify-resource-actions-ui.mjs` fixture stops at an assertion that expects a heading element on the website monitoring page. The unchanged `WebsiteMonitoring.tsx` on `origin/main` renders that title as `<strong>`; this is an existing fixture mismatch, not a failure in the changed operations pages. The new browser fixture covers the affected list and HTTPS flows.

## Architecture and compatibility

`docs/system-design.md` §131.1 records the staged read and status handoff; §33.5 records local file selection and existing certificate binding. Standard resource and overview responses, encrypted certificate storage, website reference IDs and publication behavior remain compatible. No production certificate, DNS, website or deployment was changed during verification.
