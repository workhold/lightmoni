# Plan

1. Bump all registered platform, Agent, SDK, MCP, installer, build, Compose, and documentation version references to 0.1.9.
2. Run version, type, build, targeted Agent lifecycle, and UI regressions.
3. Merge the release PR and build the final merged `main` locally for linux/amd64.
4. Run isolated image validation, publish fixed and convenience tags, and read back the registry digest.
5. Back up production state, switch only the center image reference, and verify center/MCP/UI health.
6. Use the reviewed Agent rollout path for remaining 0.1.7 hosts and record actual host release evidence.
