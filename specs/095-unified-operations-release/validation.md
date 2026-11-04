# Unified release validation

Source assembly includes PR92/93/94/95/96/97/98. GitHub main remains unchanged. Conflicts preserve tabbed host UI and maintenance tasks, both executor capabilities, all cluster regressions and all design sections.

New integration regression exercises upgrade HTTP API through managed 100% replacement, both capability gates, mutable-image refresh, explicit HTTP readiness, gateway acknowledgement and drain. Passed. Runtime/AI builds and runtime/web typechecks passed; web production build passed. Catalog UI (7 checks) and managed/manual health browser verification passed against independent disposable HTTP/SQLite fixtures. Full runtime: 1,500 tests, 1,467 pass, zero failures, 33 environment-dependent skips. Actual local Docker single-container/Compose persistence passed; two Linux host-network gateway tests skipped on macOS. Six upgrade/SSH browser checks passed using four actual Docker containers from the new ARM64 candidate plus real loopback SSH/PTYs. Dispatch and inventory remain controlled fixture data. ARM64 packaged-image checks passed after updating the old smoke harness to await the new streaming archive-path extractor; its failed obsolete-harness attempt is retained locally. AMD64 packaging remains in progress.

Architecture applies to composed upgrade/scheduling/credential paths. Repository section 95 and Doca saved and read back at seq1740: heading + four paragraphs + native flow (6 nodes, 5 edges) match exactly. Existing baseline, telemetry and application-upgrade native blocks unchanged. See evidence/doca-readback.json.

Production activation, executor update and sustained telemetry acceptance remain pending.
