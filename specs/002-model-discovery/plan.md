# Implementation Plan: 自动获取模型与明确连接协议

**Branch**: Existing working branch | **Date**: 2026-10-14 | **Spec**: [spec.md](spec.md)
**Input**: specs/002-model-discovery/spec.md

## Summary
Go exposes administrator-only read-only model discovery using unsaved credentials or explicit reuse of the current stored key. React debounces connection input, offers searchable manual model entry, and shows the fixed Chat Completions protocol. No model calls or new provider dependencies.

## Technical Context
**Language/Version**: Go 1.27.2; TypeScript/React; Node 22
**Primary Dependencies**: net/http, existing auth/store, Ant Design, current Mastra OpenAI-compatible adapter
**Storage**: Existing encrypted SQLite configuration, unchanged schema; discovery is ephemeral
**Testing**: Go httptest/race, Node UI helper tests, TypeScript check/build, browser review
**Target Platform**: Existing local and container web service
**Project Type**: Web application
**Performance Goals**: 700 ms debounce, 8 second total discovery timeout
**Constraints**: Two same-origin GETs at most, no redirects, 1 MiB body, 500 IDs of <=200 bytes; preserve local service support
**Scale/Scope**: One settings form and administrator endpoint

## Constitution Check
Pre-design PASS: Go retains authority/credentials; no write tools; no conversation changes; spec first; fixture evidence clearly scoped.
Post-design PASS: Discovery performs bounded reads, config PUT protects changed endpoints and saved-key queries never probe versioned fallback paths, no dependency/source copying or schema migration.

## Project Structure
Documentation: spec.md, plan.md, research.md, data-model.md, contracts/models.md, quickstart.md, tasks.md, verification.md.
Source: internal/assistant/discovery.go and discovery_test.go; service.go/provider.go/types.go; web/src/features/assistant/ModelSettings.tsx and model-discovery.ts/model-discovery.test.mjs; AssistantPage.tsx/types.ts.
**Structure Decision**: Extract model settings UI to isolate discovery lifecycle and avoid changing chat behavior. Backend and UI implement in parallel once contract is frozen.
