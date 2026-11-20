# Data model and transitions

No table or column changes are required.

`ops_instance_recoveries` retains the instance ID, run ID, frozen snapshot, status, and update time. Its linked run and Agent job identify queued, claimed, terminal, and unknown work. One managed machine has at most one in flight automatic inspection. A valid `agent_reinstall_containers_remain` result with the same snapshot stays stable until the target changes or a reviewed plan transfers the binding.

`ops_workload_recoveries` retains one active plan per machine through its existing lane index. `preparing`, `awaiting_approval`, `verifying`, and `unknown` suppress automatic checks. Existing plan snapshots and proof hashes continue to gate the transfer. Terminal plans release suppression.

Cancelling an unclaimed automatic Agent job produces the existing cancelled receipt and linked status. A claimed or unknown job is never silently cancelled during plan creation. Read only reconciliation may release an unknown privileged host fence, but the job and platform run remain unknown and their history stays queryable.
