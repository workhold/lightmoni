# Feature Specification: Progressive operations pages and HTTPS certificates

**Feature Branch**: `codex/187-progressive-ops-certificates`
**Created**: 2026-11-19
**Status**: Ready for implementation

## User Scenarios & Testing

### User Story 1 - Show operations data as it arrives (Priority: P1)

An administrator opening Applications or Websites sees registered configurations as soon as they are available. Status that has not arrived is explicitly loading; the list remains usable while the remaining overview data loads.

**Independent Test**: Delay the status overview response while returning configurations promptly. Confirm resource names and configuration details are visible before status arrives, then confirm only status and dependent details update.

**Acceptance Scenarios**:

1. **Given** registered applications and a delayed overview, **when** Applications opens, **then** application cards appear before the overview completes and every unknown status reads “加载中 / Loading”.
2. **Given** a delayed overview, **when** it completes, **then** status, machine and cluster names, and available actions update without clearing the list.
3. **Given** a failed status request, **when** the configuration response succeeded, **then** the configurations remain visible, status reads “加载失败 / Failed to load”, and retry can recover.
4. **Given** rapid navigation or refresh, **when** an older response arrives later, **then** it cannot replace newer page data.

### User Story 2 - Import a certificate from files (Priority: P1)

An administrator can register a certificate using a certificate chain file and a private key file, alongside the existing platform managed issuance path. The private key is handled through the existing protected certificate save path.

**Independent Test**: Select local PEM files in Certificate management, save, and confirm that the certificate is available for website selection; reject oversized or invalid material without exposing its contents in messages.

**Acceptance Scenarios**:

1. **Given** a new uploaded certificate, **when** the administrator selects the chain and key files, **then** their contents populate the existing certificate fields and no upload request occurs before saving.
2. **Given** an existing uploaded certificate, **when** the administrator leaves both file inputs empty, **then** the saved material is retained.
3. **Given** invalid or oversized files, **when** the administrator selects them or saves, **then** a bounded error appears and the server does not accept invalid material.

### User Story 3 - Choose a certificate in HTTPS settings (Priority: P1)

An administrator configuring a website can select, for each HTTPS domain binding, an existing platform issued or uploaded certificate from Certificate management. Certificate choice is visible in the HTTPS settings area of the editor.

**Independent Test**: Enable HTTPS on a binding, choose either certificate source, save and reopen the website; the same certificate ID remains selected.

**Acceptance Scenarios**:

1. **Given** an HTTPS binding, **when** HTTPS settings opens, **then** the binding's domains and certificate selector appear there with certificate source and readiness indicated.
2. **Given** multiple HTTPS bindings, **when** different certificates are chosen, **then** each binding retains its own certificate ID.
3. **Given** a certificate not yet issued or imported, **when** the administrator views the option, **then** it is identified as not ready; existing server validation still prevents publication without usable material.

### Edge Cases

- No registered resources: the empty state appears only after the configuration request completes.
- A certificate file may contain a chain; file size follows the existing server limits of 128 KiB for chain and 64 KiB for key.
- A slow inventory request for a host filtered application list does not delay unfiltered application data; a host filtered list waits for inventory instead of showing incorrect matches.
- Existing websites and certificates preserve IDs, revisions, references and saved secrets.

## Requirements

### Functional Requirements

- **FR-001**: Applications and Websites MUST reveal configuration data independently of the complete status overview.
- **FR-002**: Pending or failed status MUST be distinguishable from stopped, unpublished and other real states.
- **FR-003**: Status dependent actions MUST remain unavailable until authoritative status is loaded.
- **FR-004**: Older responses MUST NOT overwrite newer navigation or refresh results.
- **FR-005**: Certificate management MUST accept local PEM chain and key files through the existing uploaded certificate workflow, without transmitting them before save.
- **FR-006**: File selection MUST enforce existing size limits and server validation MUST remain authoritative for key matching, domains and certificate validity.
- **FR-007**: Website HTTPS settings MUST offer a per binding selector for existing certificates, including platform issued and uploaded sources.
- **FR-008**: No certificate or private key material MUST appear in list responses, logs, URLs, or error messages.

### Key Entities

- **Resource configuration**: Registered application, website or certificate metadata and desired settings, independent of observed status.
- **Observed status**: Current operations state and related evidence obtained after configuration display.
- **Certificate**: Existing managed or uploaded resource with protected PEM material and public readiness metadata.
- **Website binding**: Domain group with an HTTPS flag and one certificate reference.

## Success Criteria

### Measurable Outcomes

- **SC-001**: In a test where status is held for 3 seconds, registered application and website names appear before status is released.
- **SC-002**: Every pending status in that test visibly reads Loading, and every failed status read visibly reads Failed to load; none appears as stopped or unpublished.
- **SC-003**: An administrator can import chain and key files and select the resulting certificate for an HTTPS binding in one visit to the management pages.
- **SC-004**: Existing certificate selections survive a save and reopen cycle for multiple bindings.

## Assumptions

- “平台绑定” means selecting an existing platform managed certificate (ACME or self signed) from Certificate management, while uploaded material uses the same certificate resource and website reference path.
- This work does not import certificates directly from a cloud provider account or change cloud delivery targets.
- Existing administrator permissions and certificate material encryption remain in force.

## Architecture Impact

Applicable: the operations page reads configuration before its status overview, changing the browser-to-center read sequence and public read projection. `docs/system-design.md` §131.1 and §33.5 are updated in this same change. Certificate storage, encryption, website reference and deployment paths are unchanged.
