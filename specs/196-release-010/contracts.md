# SDD 196 release contracts

- Version: 0.1.10.
- Planned fixed image: `docker.heyphp.com/lightmoni/lightmoni:v0.1.10-20261121-053914-amd64`.
- Image platform: linux/amd64; bundled Agent archives include linux/amd64 and linux/arm64.
- The fixed tag is immutable and is the only production Compose reference; `latest` is a convenience alias.
- Build source must be the final merged GitHub `main` revision after this release PR.
- Production preserves the existing project name, environment, master key, state volume, telemetry volume, and ClickHouse service.
- The unresolved 0.1.9 vchive update must be reconciled or recovered through its native audited path before a new rollout; prior rollback failure/unknown cannot be acknowledged as success.
- All Agent upgrades use the reviewed serial rollout protocol and stop on failed, rolled-back, or unknown outcomes.
