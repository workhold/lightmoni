# SDD 193 release contracts

- Version: 0.1.9.
- Planned fixed image: `docker.heyphp.com/lightmoni/lightmoni:v0.1.9-20261120-182707-amd64`.
- Image platform: linux/amd64. The image bundles linux/amd64 and linux/arm64 Agent archives, but does not claim an arm64 center image.
- The immutable fixed tag is the production Compose reference. `latest` is only a convenience alias.
- Build source must be the final merged GitHub `main` commit after this release PR; OCI revision and source revision must match exactly.
- Production must retain the existing Compose project, `.env`, master key, state volume, telemetry volume, and ClickHouse service.
- Agent updates use the existing reviewed rollout protocol and stop on failed, rolled-back, or unknown outcomes.
