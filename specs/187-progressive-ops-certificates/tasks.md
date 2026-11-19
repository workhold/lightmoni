# Tasks: Progressive operations pages and HTTPS certificates

## User Story 1: Progressive resource display

- [x] T001 [US1] Add opt-in sanitized config projection and contract check to `runtime/src/ops/index.ts`.
- [x] T002 [US1] Stage Applications and Websites reads in `web/src/app/OperationsPage.tsx`, guard stale results and handle host inventory separately.
- [x] T003 [US1] Show pending and failed status accurately in application and website cards, with status dependent actions gated.
- [x] T004 [US1] Add delayed overview browser regression for first content, status handoff and failure/retry.

## User Story 2: PEM file import

- [x] T005 [US2] Add local chain/key file selection, size feedback and no automatic upload to `ResourceFields.tsx`.
- [x] T006 [US2] Verify the existing server validator and public redaction contract using existing certificate tests.

## User Story 3: Certificate choice in HTTPS settings

- [x] T007 [US3] Put a per binding certificate selector and readiness/source labels in the website HTTPS accordion, preserving saved IDs.
- [x] T008 [US3] Verify two binding selections survive form save/reopen and a newly uploaded certificate is selectable.

## Documentation and acceptance

- [x] T009 Update `docs/system-design.md` §131.1 and §33.5 and record checks in `evidence/acceptance.md`.
- [x] T010 Sync `origin/main`, run relevant checks, review diff, commit and open a PR to `main`.
