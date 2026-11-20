# Feature Specification: Restore bindings after Agent reinstallation

**Feature Branch**: `codex/191-agent-reinstall-recovery`

**Created**: 2026-11-20

**Status**: Implemented locally; production validation pending

**Input**: Production issue [#265](https://github.com/workhold/lightmoni/issues/265): automatic inspection of old instances competes with administrator reviewed binding recovery after an Agent is reinstalled.

## User Scenarios & Testing

### User Story 1 - Complete reviewed binding recovery (Priority: P1)

An administrator whose Agent was reinstalled can review the old applications on that host, verify their retained containers and data, approve recovery, and see the original application bindings restored. Existing application data and historical execution results remain intact.

**Why this priority**: The four production applications are running but cannot currently be managed through their original platform bindings.

**Independent Test**: On a host with old instances and a new Agent, complete a reviewed recovery plan and confirm the original instances are bound to the new Agent without changing their remote data.

**Acceptance Scenarios**:

1. **Given** old instances with retained containers and a new Agent, **when** an administrator starts a reviewed recovery, **then** automatic inspection does not prevent its read only checks from completing.
2. **Given** a complete and approved plan with unchanged evidence, **when** the second check succeeds, **then** each original instance and its port reservations belong to the new Agent and the plan has a durable success receipt.
3. **Given** an unknown, stale, or conflicting execution or changed evidence, **when** recovery is requested, **then** the system keeps the original bindings and reports the reason.

---

### User Story 2 - Stable automatic inspection (Priority: P2)

An administrator can see a stable “containers remain” result after the new Agent confirms old containers are present. Automatic checks of different old instances on the same host do not compete for the same execution channel.

**Why this priority**: Repeated and overlapping checks currently obstruct the reviewed path and unrelated host operations.

**Independent Test**: Reconcile a host with multiple old instances, return a “containers remain” result, and confirm no further automatic check is queued for unchanged evidence while manual recovery remains available.

**Acceptance Scenarios**:

1. **Given** several eligible old instances on one host, **when** automatic recovery runs, **then** no more than one automatic inspection is in flight for that host.
2. **Given** a valid result showing old containers remain, **when** reconciliation repeats with the same target, **then** the result remains visible and no duplicate inspection is queued.
3. **Given** an active administrator recovery plan, **when** reconciliation repeats, **then** no new automatic inspection is queued on that host.

### Edge Cases

- A queued or running automatic inspection already exists when an administrator starts a plan.
- An automatic check fails, is cancelled, or has an unknown result.
- The Agent identity, host binding, application configuration, or observed inventory changes between plan and approval.
- A previously retained container disappears; the next plan must use fresh evidence rather than assuming the old result remains valid.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST allow no more than one automatic old instance inspection to be in flight for a host at a time.
- **FR-002**: The system MUST stop repeating automatic checks after valid evidence confirms old containers remain for an unchanged target, while preserving the result and administrator recovery path.
- **FR-003**: The system MUST defer automatic checks while an administrator recovery plan is active on that host.
- **FR-004**: The administrator recovery path MUST handle an existing automatic check without letting the two paths compete for host execution; an in flight check must finish or be safely cancelled before the reviewed check begins.
- **FR-005**: Unknown or unverified execution results MUST continue to block unsafe replacement or binding transfer. Read only classification MUST be based on the exact validated operation, not a broad task label.
- **FR-006**: Reviewed recovery MUST retain original instance IDs, data paths, port reservations, application configuration, and historical audit. It MUST NOT write to remote application containers or data.
- **FR-007**: The result MUST show whether the platform binding and repository image list were actually verified; container presence alone MUST NOT count as success.

### Key Entities

- **Old instance**: An application instance still associated with a prior Agent identity on the same managed host.
- **Automatic inspection**: A read only check and its durable result for an old instance.
- **Reviewed recovery plan**: A host wide administrator plan with frozen target, two checks, approval, and final receipt.
- **Host execution lane**: The mutually exclusive path for operations on one managed host.

## Success Criteria

### Measurable Outcomes

- **SC-001**: In tests with four old instances on one host, at most one automatic inspection is active at any moment.
- **SC-002**: For an unchanged valid “containers remain” result, ten consecutive reconciliations queue zero additional inspections.
- **SC-003**: A reviewed plan on an otherwise idle host completes both checks and transfers every eligible binding in one attempt.
- **SC-004**: A changed or unresolved target transfers zero bindings and retains the original audit.
- **SC-005**: Production validation reports the management state of all four affected applications and the repository image list separately from container health.

## Assumptions

- The production applications and their retained data belong to the same managed host already registered with the new Agent.
- The existing administrator review, Agent capability, signed execution, and approval controls remain the authority for binding transfer.
- A valid “containers remain” observation should wait for administrator action; automatic retry adds no new evidence while the target is unchanged.
