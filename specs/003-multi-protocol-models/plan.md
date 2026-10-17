# Implementation Plan: 主流模型协议
**Date**: 2026-10-14 | **Branch**: Existing working branch | **Spec**: [spec.md](spec.md)

## Summary
Expose visible discovery action and protocol selector, keep automatic query, add bounded base-path repair, an explicit real-connection verification action, and a provider-mapped reasoning control to the existing Mastra loop. Go owns config/discovery and encrypted secrets. Preserve user old tab; open fresh delivered UI.

## Technical Context
**Language/Version**: Go 1.27.2, TypeScript/React, Node22, Mastra1.66.0
**Dependencies**: Existing openai-compatible3.0.48; pinned openai4.0.66/anthropic4.0.53/google4.0.69 all provider4.0.14/utils5.0.40
**Storage**: Config JSON adds concrete protocol; legacy blank -> Chat. SQLite schema unchanged.
**Testing**: Native SDK fixture integration, Go race/contract, frontend lifecycle checks/typecheck/build/browser.
**Platform/Type**: Existing Go web host and private Node worker.
**Constraints**: Same-origin catalog requests≤7, total8s, body1MiB, 500 model IDs; saved key no version path fallback; generated probe only after explicit test action; no personal key reuse from old DOM; reasoning override is omitted by default and must remain best-effort across providers.
**Performance**: 700ms debounce; same existing execution limits. A reasoning preference applies to each model step and the bounded history summarizer, without changing host input/output/step limits.

## Constitution Check
PASS pre/post-design: host credentials/tools unchanged; specification before app edits; only read catalogs; concrete config reviewed by UI save; provider dependencies pinned; no Doca source copied; no plaintext provider errors. Four native SDKs remain behind one Mastra loop. UI preserves old unsaved inputs.

## Project Structure
Docs: spec/plan/research/data-model/contracts/quickstart/tasks/verification under specs/003-multi-protocol-models.
Go: internal/assistant/{provider,protocol_rules,types,service,discovery,discovery_test}.go; protocol policies centralize version repair, ordered candidates, catalog headers/query parameters; native SDK fixtures in ai-runtime/test and/or internal/assistant/runtime_test.go.
Node: ai-runtime/src/model.ts, protocol.ts, runner.ts, tests, package.json/package-lock.json.
UI: ModelSettings.tsx, model-discovery.ts/tests, types.ts, model-protocol.ts helper if needed.
Ownership: backend, runtime, frontend separate agents after shared contract; root coordinates docs/final review/build and user tab handoff.
