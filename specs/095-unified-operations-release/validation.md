# Unified release validation

Source assembly includes PR92/93/94/95/96/97/98. GitHub main remains unchanged. Conflicts preserve tabbed host UI and maintenance tasks, both executor capabilities, all cluster regressions and all design sections.

New integration regression exercises upgrade HTTP API through managed 100% replacement, both capability gates, mutable-image refresh, explicit HTTP readiness, gateway acknowledgement and drain. Passed. Runtime/AI builds and runtime/web typechecks passed; web production build passed. Catalog UI (7 checks) and managed/manual health browser verification passed against independent disposable HTTP/SQLite fixtures. Full runtime: 1,500 tests, 1,467 pass, zero failures, 33 environment-dependent skips. Actual local Docker single-container/Compose persistence passed; two Linux host-network gateway tests skipped on macOS. Six upgrade/SSH browser checks passed using four actual Docker containers from the new ARM64 candidate plus real loopback SSH/PTYs. Dispatch and inventory remain controlled fixture data. ARM64 packaged-image checks passed after updating the old smoke harness to await the new streaming archive-path extractor; its failed obsolete-harness attempt is retained locally. AMD64 packaging remains in progress.

Architecture applies to composed upgrade/scheduling/credential paths. Repository section 95 and Doca saved and read back at seq1740: heading + four paragraphs + native flow (6 nodes, 5 edges) match exactly. Existing baseline, telemetry and application-upgrade native blocks unchanged. See evidence/doca-readback.json.

Production activation, executor update and sustained telemetry acceptance remain pending.

## 2026-11-05 catalog release continuation

User requested PR100 in this release. Merge source a418b64 contains 35 apps and 8 categories. All 65 targeted combined regressions, typechecks and builds pass. Four catalog UI locale/theme/viewport combinations pass with no page errors. Actual Meilisearch production authentication, indexing and search, plus RustFS signed S3 bucket/object operations and console health pass; disposable resources were cleaned. Firecrawl image transfer continues; its business smoke is pending.

Fixed source a418b64e9b56ae5dd108b502f11e66bb8b9be850 was built and published as 20261105-ops-a418b64. Both architectures pass 44 packaged-image checks each. Registry pull confirms exact tested RootFS and Config. Index: sha256:c6f5c3ebe0dac3666ee5ba4b862a504769dc1ef415fbefe55b6cc3961a46d15a. The earlier b975a95 candidate is historical. Stable latest remains unchanged.

Doca latest seq1741 readback verifies catalog/Logo paragraphs, heading and five new paragraphs verbatim; the coordinated release native diagram retains its six nodes and five edges. Existing confirmed writes remain valid; no new topology was added by this merge. See evidence/doca-catalog-readback.json.

Production readonly check showed no unresolved privileged jobs. Mac subsequently locked; computer control refused the activation attempt and requires manual unlock. Activation script has not been staged or executed. Backup, CAS switch, executor update and live telemetry/dashboard acceptance remain pending.

Additional continuation checks: full runtime 1502 tests / 1469 pass / 33 environmental skips / zero failures; AI 71 pass and SDK TypeScript 23 pass. All 31 extended recipes (65 services) passed Docker Compose configuration. Six application-upgrade/container-terminal browser checks passed against the new image with real Docker and SSH/PTTY, including hostname equality with the selected container. This does not substitute for pending production acceptance.

Firecrawl download blocker: both canonical GHCR and the Nanjing mirror attempts failed to commit the browser layer. Expected sha256:45f4d16cf8ff92019a313bb4f67c1b5b8f5861181a5972355c2d8a057224d23e; returned sha256:d4bdf2eb61f888f9bc88ca368347ada1cc9660c6eb7fa06fa84dd9351c751f00. Docker refused the mismatched data. API and NuQ database images were pulled and canonical digests verified, but no five-service business-smoke pass is claimed. No production application was created by these tests.

## 2026-11-05 production activation

After manual Mac unlock the exact staged activation script completed. Native terminal readback of activate.result.json confirms fixed image 20261105-ops-a418b64 and the tested index/source, healthy center, matching compiled-module fingerprints and expected capabilities. The script waited for an idle privileged queue, backed up SQLite/master key/deployment config on the protected server, changed only the center image and retained all other 16 container IDs. Inventory counts remained users=1, resources=18, machines=2, agents=6, credentials=26. See evidence/production-activation.json; this is a transcription of native terminal readback, not a downloaded copy of the receipt.

Actual Agent upgrade and sustained telemetry acceptance remain pending. Host zz-bj-1 exposes the expected old source 0b4568316cb9; normal upgrade entry currently observes a running-operation gate. Host vchive reports source 790cca58456a, monitoring-only and no active SSH credential. The Mac locked again before the remaining UI work; a second manual-unlock request is pending. No maintenance gate was bypassed.

Firecrawl AMD64 browser image was subsequently pulled and verified against the canonical fixed index. An isolated five-service run (ARM64 API/database plus explicitly emulated AMD64 browser) reached scrape HTTP success, but example.com returned empty Markdown; a follow-up run hit the old 60-second Compose harness timeout. These attempts are retained as failed. A longer isolated IANA-page run is in progress; no business-smoke pass is claimed yet.

## Firecrawl completed acceptance

The final tracked fixture passed with five real services. The IANA scrape returned HTTP 200, success=true, metadata.statusCode=200 and expected nonempty Markdown. API/database ran on ARM64; the pinned browser ran as explicitly selected linux/amd64 under emulation. Canonical browser index verification passed. This does not validate the native ARM64 browser layer that previously failed integrity checks. The QA-only manifest resolves the fixed IANA target using public DoH to avoid the local Fake-IP DNS; SSRF and TLS checks remain enabled and production recipes/networking are unchanged. All temporary containers/networks/volumes and credentials were removed. Reproduction and options are in spec094/quickstart.md; machine-readable results are in evidence/catalog-integration.json and spec094/evidence/live.json.

The fixture and fixed default image update do not change production architecture: architecture synchronization is not applicable to these changes because component/control/credential boundaries and topology are unchanged. Existing functional architecture readbacks remain valid.
