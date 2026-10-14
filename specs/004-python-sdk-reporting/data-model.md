# Data Model

## Rule snapshots
SDKConfig = revision:string (1..128 bytes), log_sampling:dict (<=200 valid non-system logical tables), disable_rules:list (<=32).
Policy = key (default event_id), rules (required array, <=32), exclude (default []). Rule = name (<=64 UTF-8 bytes), rate (0 or 0.000001..1), conditions (required array, <=8). Exclusion conditions must be nonempty.
Condition = field, operator in/exists, values. in requires 1..256 string/bool/finite numeric values; exists has no values. Fields: service, instance_id, sdk.language, severity, trace_id, event_id, attr:..., resource:...; SDK stop selectors permit only service/instance_id/sdk.language/resource.
Each policy <=64 KiB serialized, config response <=1 MiB. Unknown fields and duplicate JSON keys are invalid. Whole config validates before any mutation.

## Shared state
local_sampling and remote_sampling snapshots; local_disabled OR remote_disabled yields reporting_disabled. reporting_generation increments on disable and invalidates old spans and delivery results. source_sequence creates per-log event sampling identity. config_revision/config_error and sampled_out_logs/unmatched_logs/excluded_logs/disabled_records extend stats.
Root configuration worker and heartbeat run independently and share one shutdown stop event. All child table clients share state. shutdown marks closing before network work, stops polling and rejects late config; final flush retains existing deadline/failure behavior.

## Transitions
- Enabled → Disabled: increment generation, cancel active delivery, wake retry, discard metric series/records/queue, reset buffer/pending stats; register counts as disabled_records, not data loss.
- Disabled → Enabled: reset collection start and self-telemetry timestamp; only fresh records/spans qualify.
- Valid config: atomic remote policy/version/disabled replacement.
- Invalid config/network error: update config_error only; previous version and policy remain.
- Policy update: future business log calls only; queued records and metrics/traces unaffected.
