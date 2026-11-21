# Plan

1. Bump all registered release surfaces to 0.1.11.
2. Run version, type, build, targeted lifecycle, recovery, and assistant regressions.
3. Merge the release PR and build final main locally.
4. Validate linux/amd64 in isolation, publish fixed/latest tags, and read back digest.
5. Preserve production state, switch center, reload proxy, and verify public/production boundaries.
6. Close the vchive lifecycle lock through its native audited path.
7. Execute and verify the 0.1.11 Agent rollout on every host.
8. Record release and production evidence.
