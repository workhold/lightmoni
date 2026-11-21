# Plan

1. Reproduce a killed explicit restore after the durable started journal and confirm it is currently non-resumable.
2. Define and document the exact journal, receipt, lock, worker, snapshot, and release-identity guards for resume.
3. Reuse the existing restore path for an approved `restore_previous` transaction and preserve its original recovery metadata on success.
4. Add runner regressions for successful resume, refusal cases, and lost final-response idempotency.
5. Update the system design and record all validation evidence.
