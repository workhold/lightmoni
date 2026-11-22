# Contracts

Assistant task create/update may send either detailed `task.host_ids`, explicit flat top-level `host_ids` with no `task.host_ids`, or omit targets when inherited/current task targets remain. Flat targets are copied into the saved task definition and legacy proposal projection. Conflicting target shapes are rejected.
