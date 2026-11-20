# Research and decisions

## Host lane ownership

**Decision**: One automatic recovery inspection occupies the host lane until its run is terminal and its execution fence is released. **Rationale**: The current loop queues several old instances while the privileged executor permits only one host operation. **Alternative**: Parallel checks are incompatible with that contract.

## Valid containers remain result

**Decision**: Keep `agent_reinstall_containers_remain` without a timed recheck while the frozen target is unchanged. A changed target can be inspected again; administrator review remains available. **Rationale**: Repeating the same inventory cannot restore a retained binding and competes with review. **Alternative**: A longer delay would only postpone the conflict.

## Reviewed plan admission

**Decision**: Cancel matching automatic jobs only when still queued. Reject with a specific retriable error when a check is claimed or unresolved. Persist the plan and queue its check in one SQLite transaction so new automatic work cannot race it. **Rationale**: An unclaimed job has no remote result; claimed work may have unknown effects. **Alternative**: Force cancellation of claimed work would violate the host fence.

## Unknown read only inspection

**Decision**: Allow only the exact signed, hashed `instance.recovery.inspect` payload to use existing read only observation reconciliation after parent job and operation checks. **Rationale**: The operation performs Docker inventory and local file reads only. Fence release never marks the original result successful or transfers a binding. **Alternative**: Any platform `inspect` label is too broad.
