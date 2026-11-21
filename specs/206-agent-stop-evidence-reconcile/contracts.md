# Contracts

- `workerStopEvidenceCommand` remains read-only and bounded to the one pinned `lightmoni-agent-update-<operation>.service`.
- Success requires:
  - systemd active state outside `active/activating/deactivating/reloading`;
  - `LoadState` in `loaded/not-found/masked`;
  - `MainPID`, `ControlPID`, and `Job` empty or zero;
  - `ControlGroup` empty or exactly `/system.slice/<unit>`;
  - existing cgroup has `populated 0` and no PIDs.
- Reconcile lock cleanup still requires durable `unknown`, `rollback_failed`, `rollback_error_code=recovery_original_unhealthy`, exact approved original probe, and worker-stop evidence.
- Cleanup remains fixed to `/run/lightmoni-agent-lifecycle.lock` and records before/after fingerprints plus evidence.
