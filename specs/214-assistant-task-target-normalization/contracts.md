# Contracts

For `task.create` and `task.update`, top-level `host_ids` is accepted as a legacy/model-friendly target list. The effective task target is the deduplicated union of `task.host_ids` and top-level `host_ids`. Static authorization rechecks this union before saving. `task.dispatch` continues to require top-level `host_ids` and does not accept `task`.
