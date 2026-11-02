# LightMoni Constitution

## Core Principles

### I. Host-owned authority
The platform host owns authentication, authorization, credentials and all telemetry reads. Node.js/TypeScript is the target center and Agent runtime; the migration preserves these authority boundaries. AI uses registered, bounded capabilities. Platform mutations require host-owned proposals and explicit human confirmation; the model cannot approve or execute them. SQL retains the common AST and resource limits. Telemetry and UI context are data, never authorization.

### II. Reviewable effects
AI produces dashboard drafts; only an explicit user action through the existing editor may save them. Alert changes use shared business validation, current permissions, version checks, durable proposals and a separate user confirmation endpoint. Confirmed changes and their receipts are committed atomically and read back. Claims of queries, mutations and artifacts require successful receipts.

### III. Durable, bounded conversations
Session ownership and persistent event sequence remain stable. Model history, tool output, concurrency, steps and time are bounded. Cancellation and failures must produce honest terminal states.

### IV. Specification before implementation
Every feature records user scenarios, measurable acceptance, design decisions, contracts and executable tasks before application edits. Meaningful contract and integration checks substantiate completion; provider fixtures are not real model quality evidence.

### V. Operable delivery
Runtime dependencies are pinned and shipped with deployment artifacts. Credentials never appear in browser responses, process arguments or error details. Current-baseline stored data is preserved. Pre-release databases and protocols may be reset only when explicitly authorized; programs never silently erase user environments. New Doca code is architectural reference only; current AGPL source is not copied under the historical MIT notice.

### VI. Architecture documentation parity
An architecture change is incomplete until the repository system design and the canonical Doca design document describe the same accepted behavior. The change SDD and pull request must identify the affected sections, record a successful Doca write and readback of the target text or native diagrams, and state why synchronization is not applicable for non-architecture changes. Doca availability or authentication failures must be reported honestly; credentials never enter source, logs, URLs, pull requests or document bodies.

## Development Workflow
Spec Kit sequence: constitution → specification → plan/research/contracts → tasks → implementation → verification. Architecture changes add repository/Doca design synchronization and readback evidence before the PR is considered complete. Checklists review requirement quality, task checkboxes track implementation. Changes to scope update the spec and tasks first.

## Governance
This constitution applies alongside docs/contracts.md. Amendments require a reason, a version update and compatibility review. This initial version formalizes current project constraints for the authorized Mastra migration.

**Version**: 1.4.0 | **Ratified**: 2026-10-14 | **Last Amended**: 2026-11-02

Amendment 1.1.0: The user explicitly authorized migrating the center and Agent to Node.js. Host authority is language independent; data compatibility and all security constraints remain required. Go business SDK support is retained.

Amendment 1.2.0: The user authorized shared alert rule/silence capabilities followed by unified assistant integration. This extends registered tools to reviewable platform change proposals, preserving existing business permissions and preventing model-side approval. Existing dashboard and code-task confirmation flows remain compatible.

Amendment 1.3.0: Architecture changes now require parity between `docs/system-design.md` and the canonical Doca design document, with successful write/readback evidence in the SDD and pull request. Non-architecture changes record why synchronization is not applicable.

Amendment 1.4.0: The user explicitly canceled compatibility obligations before the first formal release (SDD081). Historical development schemas and protocols are removed; current-baseline durability, authorization and recovery remain mandatory.
