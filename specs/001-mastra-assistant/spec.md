# Feature Specification: Monitoring assistant evolution

**Feature Branch**: existing `main` (feature directory independent of branch)
**Created**: 2026-10-14
**Status**: Implemented; fixture acceptance passed (real provider and Docker acceptance pending)
**Input**: 使用 SDD / GitHub Spec Kit 完善 LightMoni AI 助手，接入 Mastra；参考本地 Doca 架构。

## User Scenarios & Testing

### User Story 1 - Reliable monitoring conversations (Priority: P1)
A logged-in member asks about telemetry and sees streamed answers, table inspection and bounded SQL execution without changing the existing workflow.
**Why this priority**: Preserve the useful product while replacing execution internals.
**Independent Test**: A deterministic model fixture asks for a registered table tool, consumes its real receipt and produces a final answer visible in live and reloaded history.
**Acceptance Scenarios**:
1. Given configured model access and telemetry, when a member asks for analysis, then tool parameters/results and answer appear in sequence and persist under that member's session.
2. Given another user's session, an unknown tool or modifying SQL, when access is attempted, then the host rejects it without changing telemetry.
3. Given an unavailable model or runtime, when a turn starts, then the user receives a truthful, credential-free failure and can start another turn.

### User Story 2 - Continue a long investigation (Priority: P2)
Members continue investigations without manually abandoning a conversation solely because its history has grown.
**Why this priority**: Query results consume much more context than ordinary chat.
**Independent Test**: A history exceeding the configured input allowance is compacted as complete turns; the latest request and recent tool exchanges remain intact.
**Acceptance Scenarios**:
1. Given long history, when another turn starts, then earlier complete turns are summarized, summary progress is visible, and the newest request remains unaltered.
2. Given failed summarization, when the model fails, then no old history is silently removed and the user can retry.
3. Given a request too large even after summarization, then an actionable size error is returned without sending an oversized prompt.

### User Story 3 - Understand and control execution (Priority: P2)
Members can stop work, inspect reported model usage, and review generated dashboards before saving.
**Why this priority**: Cost, control and accurate operation receipts matter for monitoring.
**Independent Test**: Cancel a stalled model fixture; verify terminal cancellation and no further tools. Complete a draft turn, reload its usage, preview and explicitly save through the existing editor.
**Acceptance Scenarios**:
1. Given a running request, when stopped, then no subsequent tools execute and its timeline shows cancelled.
2. Given model-reported token counts, when finished, then counts persist and display; unavailable counts are not invented.
3. Given a draft, when generation finishes, then it is explicitly unsaved and only the existing confirmation flow saves it.

### Edge Cases
- Tool output is too large; host returns a narrowing error before exposing it to the model.
- Model emits malformed tool input, parallel calls, fragmented deltas or provider errors.
- Runtime process exits mid-turn, browser disconnects or the turn times out.
- Older stored sessions lack summary and usage fields.
- A history boundary includes a tool exchange; compaction must never leave an orphan tool result.

## Requirements

### Functional Requirements
- **FR-001**: Preserve existing authenticated configuration, sessions, turn and cancel interfaces and historical messages.
- **FR-002**: Execute model decisions with the selected agent engine; execute all business tools under host authority.
- **FR-003**: Preserve catalog, schema, bounded query and unsaved dashboard draft capabilities.
- **FR-004**: Maintain member session isolation, encrypted model credentials, query limits and review-before-save behavior.
- **FR-005**: Bound input context and summarize older complete rounds while retaining at least the latest user request and the most recent complete round where budget permits. Preserve source history for display.
- **FR-006**: Persist summaries and expose summarization status; do not silently discard history on failed compaction.
- **FR-007**: Record provider-reported input/output/total usage with separate compaction usage when supplied, without inventing cost or counts.
- **FR-008**: Propagate cancellation/timeouts to model and tools, release the active-turn slot and emit one terminal state.
- **FR-009**: Stream text smoothly and persist periodically rather than rewriting history on every tiny delta; persist completed checkpoints before success.
- **FR-010**: Provide configurable bounded input/output/step limits with backwards-compatible defaults and ship all required runtime dependencies.
- **FR-011**: Sanitize provider/runtime errors; credentials do not appear in process arguments, stdout events or browser data.

### Key Entities
- **Session**: member-owned conversation, source messages/events, compacted prefix and summary.
- **Turn**: bounded execution, step and tool receipts, reported model usage, terminal state.
- **Model configuration**: encrypted key, model endpoint/name, enablement and execution limits.
- **Draft**: reviewable dashboard proposal, never an automatic write.

## Success Criteria

### Measurable Outcomes
- **SC-001**: Fixture scenarios for catalog → query → answer and dashboard draft finish with ordered durable receipts and no automatic save.
- **SC-002**: A conversation beyond its input allowance continues after compaction without losing its newest request or splitting a tool exchange.
- **SC-003**: A stalled fixture stops within 3 seconds of cancellation and the same session accepts a later request.
- **SC-004**: Cross-user access, unknown tools and modifying SQL are rejected in all acceptance fixtures.
- **SC-005**: All reported token counts survive reload; raw fixture credentials never appear in returned events or failures.

## Assumptions
- Scope is interactive monitoring, SQL and dashboard assistance with the current tools. Autonomous remediation, scheduled analysis, MCP, persistent background jobs and extra reviewer calls are deferred.
- At most four turns run concurrently per instance; a busy response leaves sessions intact. Browser disconnection cancels the active turn; completed checkpoints survive, in-flight work does not auto-resume after process restart.
- Model configuration is supplied explicitly by an administrator. No personal Doca credentials are read.
- Real model quality requires a configured provider; protocol fixtures verify integration and boundaries only.
