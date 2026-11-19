# Implementation Plan: Progressive operations pages and HTTPS certificates

**Branch**: `codex/187-progressive-ops-certificates` | **Date**: 2026-11-19 | **Spec**: [spec.md](spec.md)

## Summary

Expose a configuration-only variant of the existing resource list. Applications and Websites render it first with an explicit pending status, then replace it with the full overview. Host inventory resolves separately. Add local PEM file selection in Certificate management and show per-binding certificate choice in the website HTTPS settings section.

## Technical Context

**Language/Version**: TypeScript, Node.js 22, React 19
**Primary Dependencies**: Existing ops router, resource store, Ant Design form controls
**Storage**: Existing encrypted certificate resource storage; no schema change
**Testing**: Runtime contract checks, web typecheck, Playwright fixture
**Target Platform**: Browser and center service
**Performance Goal**: First resource cards do not wait for delayed overview
**Constraints**: Preserve admin auth, revision checks, material secrecy and existing upload validation

## Constitution Check

- Host controls all certificate material and authorization. The browser only reads local files into the existing save form.
- No deployment or certificate issuance is triggered by page display or file selection.
- The existing certificate save path validates and encrypts material; public projections do not expose PEM or keys.
- Architecture change is documented in `docs/system-design.md` with contract and UI evidence.

## Design Decisions

1. `GET /ops/resources?kind=<kind>&view=config` keeps the existing response envelope and omits status. The standard route is unchanged. The config path still applies `publicSpec` sanitization.
2. Only Applications and Websites use the staged read. Other operations pages keep the existing overview behavior.
3. The page tags config-only resources as pending; status helpers and controls treat pending/error as unknown, not as a real stopped or unpublished state.
4. A single request generation and abort controller guard each staged read. Quiet refresh retains the last authoritative status while fetching.
5. Browser file selection has a local size check and no automatic upload. The existing backend certificate validator remains authoritative.
6. Certificate selection moves from the domain row into the HTTPS accordion while retaining `spec.bindings[].certificate_id` and existing server contract.

## Project Structure

```text
runtime/src/ops/index.ts                 # Config-only resource projection
web/src/app/OperationsPage.tsx           # Staged read and state handoff
web/src/app/ops/{InstalledApplications,WebsiteOverview,website-state,model}.tsx/ts
web/src/app/ops/{ResourceFields,WebsiteFields,NginxFields}.tsx
docs/system-design.md
specs/187-progressive-ops-certificates/
```

## Compatibility

No database migration. Standard resource and overview responses remain compatible. Existing website certificate IDs and uploaded certificate resources remain valid. The new query value is opt in.
