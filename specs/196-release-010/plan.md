# Plan

1. Merge the brand-version and install-gating fixes into the release branch.
2. Bump all registered release surfaces to 0.1.10.
3. Run version, type, build, targeted lifecycle, brand-version, and bulk-action regressions.
4. Merge the release PR and build the final `main` locally.
5. Validate the image in isolation, publish fixed/latest tags, and read back digest.
6. Preserve production state, switch only the center image, reload the reverse proxy if needed, and verify production UI/API.
7. Resolve the paused 0.1.9 vchive record through native reconciliation/recovery, then create and execute the reviewed 0.1.10 Agent rollout.
8. Record final production and host evidence.
