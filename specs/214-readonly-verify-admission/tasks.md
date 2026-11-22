# Tasks

- [x] T001 Thread `readOnlyObservation` from `store.queue` (task ends `.inspect`/`.logs`) into `jobs.enqueue`; skip `assertManagedJobAdmission` for those managed jobs (agent-jobs.ts / store.ts).
- [x] T002 Defer verify dispatch failures in the deployment.instance provider: `pending`/`verify_dispatch_deferred` + `logger.warn`, no crash loop (cluster-workloads.ts).
- [x] T003 Regression tests: unknown `task_run` fences writes but not read-only verification (inspect enqueues, executes, instance recovers, redeploy 409); dispatch refusal defers instead of `reconciliation_failed`. Both fail on unfixed code.
- [x] T004 Update `docs/system-design.md` ch.213 with the admission carve-out.
- [x] T05 Affected suites green (162/162); release 0.1.24.
