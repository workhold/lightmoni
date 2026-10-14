# Tasks: Python SDK 远程上报控制
**Input**: [spec.md](spec.md), [plan.md](plan.md), research/data-model/contracts.
**Tests**: Required by FR-010; contract tests precede implementation.

## Phase 1: Setup
- [x] T001 Record scenarios and quality review in specs/004-python-sdk-reporting/spec.md and checklists/requirements.md.
- [x] T002 Resolve decisions and API in specs/004-python-sdk-reporting/plan.md, research.md, data-model.md, contracts/reporting.md and quickstart.md.

## Phase 2: Foundation
- [x] T003 Create failing HTTP/contract tests in sdk/python/tests/test_reporting.py.
- [x] T004 Implement strict rule snapshots, scalar tokens and stable hash in sdk/python/lightmoni/sampling.py.
- [x] T005 Implement deadline and cancellation transport in sdk/python/lightmoni/transport.py.

## Phase 3: US1 日志选择 (P1)
**Independent test**: actual HTTP payload includes QA/VIP, excludes UID/unmatched, leaves metric/trace counts unchanged.
- [x] T006 [US1] Add local policy/resource inputs and update_log_sampling to sdk/python/lightmoni/__init__.py.
- [x] T007 [US1] Apply policy only at log calls with authoritative sampling metadata and independent ignore counters in sdk/python/lightmoni/__init__.py.
- [x] T008 [US1] Validate fixed cross-language vectors and 10,000-user stable distribution in sdk/python/tests/test_reporting.py and sdk/go/python_sampling_test.go.

## Phase 4: US2 整体停报 (P1)
**Independent test**: stop clears all shared buffers/queue, cancels waiting HTTP/backoff, old spans and late results never reappear after resume.
- [x] T009 [US2] Implement shared local/remote disabled state, generation and Span guards in sdk/python/lightmoni/__init__.py.
- [x] T010 [US2] Integrate cancellable transport and generation-aware flush/backoff in sdk/python/lightmoni/__init__.py.
- [x] T011 [US2] Verify stop/resume races and all signal/self-monitoring suppression in sdk/python/tests/test_reporting.py.

## Phase 5: US3 配置生命周期 (P2)
**Independent test**: real authenticated GET, bounded errors retain snapshot, polling resumes even when telemetry stopped and self-monitoring off.
- [x] T012 [US3] Add explicit refresh, independent polling, key rotation and sanitized diagnostics in sdk/python/lightmoni/__init__.py.
- [x] T013 [US3] Stop configuration work and reject late apply during shutdown in sdk/python/lightmoni/__init__.py.
- [x] T014 [P] [US3] Add isolated center/Agent + real Python integration in internal/server/python_reporting_test.go.
- [x] T015 [US3] Verify invalid/oversize/redirect/timeout updates, frozen retry and periodic recovery in sdk/python/tests/test_reporting.py.

## Phase 6: Polish and verification
- [x] T016 Update sdk/python/README.md, sdk/README.md, docs/tasks/04-sdk.md and web/src/app/LogReportingSettings.tsx with Python support and correct background-thread behavior.
- [x] T017 Run new Python tests, scripts/test-sdks.py --languages python, relevant Go race tests, package installation and independent review; record commands/results in specs/004-python-sdk-reporting/verification.md.
- [x] T018 Verify completed task/spec consistency, git diff hygiene and preserve unrelated generated changes in specs/004-python-sdk-reporting/verification.md.

## Dependencies and parallel execution
T001–T002 precede application edits. T003 precedes T004–T013. US1/US2 share __init__.py and are implemented sequentially by root. T014 is an independent file and can run in parallel after the contract is fixed; a reviewer independently checks implementation. T016–T018 require all stories complete.
Example: root edits sdk/python/lightmoni/* while integration agent owns internal/server/python_reporting_test.go; test agent owns sdk/python/tests/test_reporting.py.

## Implementation strategy
Deliver local rule selection first, then shared stop/cancellation, then remote lifecycle; validate each story with HTTP receipts before documenting completion. No extension hooks are configured.
