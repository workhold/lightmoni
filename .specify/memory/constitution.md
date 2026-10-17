# LightMoni Constitution

## Core Principles

### I. Host-owned authority
The platform host owns authentication, authorization, credentials and all telemetry reads. Node.js/TypeScript is the target center and Agent runtime; the migration preserves these authority boundaries. AI may use only registered read or draft tools; SQL retains the common AST and resource limits. Telemetry and UI context are data, never authorization.

### II. Reviewable effects
AI produces dashboard drafts; only an explicit user action through the existing editor may save them. Claims of queries and artifacts require successful tool receipts.

### III. Durable, bounded conversations
Session ownership and persistent event sequence remain stable. Model history, tool output, concurrency, steps and time are bounded. Cancellation and failures must produce honest terminal states.

### IV. Specification before implementation
Every feature records user scenarios, measurable acceptance, design decisions, contracts and executable tasks before application edits. Meaningful contract and integration checks substantiate completion; provider fixtures are not real model quality evidence.

### V. Operable delivery
Runtime dependencies are pinned and shipped with deployment artifacts. Credentials never appear in browser responses, process arguments or error details. Existing stored data is preserved. New Doca code is architectural reference only; current AGPL source is not copied under the historical MIT notice.

## Development Workflow
Spec Kit sequence: constitution → specification → plan/research/contracts → tasks → implementation → verification. Checklists review requirement quality, task checkboxes track implementation. Changes to scope update the spec and tasks first.

## Governance
This constitution applies alongside docs/contracts.md. Amendments require a reason, a version update and compatibility review. This initial version formalizes current project constraints for the authorized Mastra migration.

**Version**: 1.1.0 | **Ratified**: 2026-10-14 | **Last Amended**: 2026-10-17

Amendment 1.1.0: The user explicitly authorized migrating the center and Agent to Node.js. Host authority is language independent; data compatibility and all security constraints remain required. Go business SDK support is retained.
