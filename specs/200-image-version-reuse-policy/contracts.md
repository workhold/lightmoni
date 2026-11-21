# Contracts

- Version scheme remains SemVer; container upgrade releases increment PATCH before building.
- `npm run version:bump <next-patch>` must update every registered release surface.
- Release image tags use `docker.heyphp.com/lightmoni/lightmoni:v<VERSION>-<YYYYMMDD>-<HHMMSS>-<ARCH>`.
- Registry tags are immutable. Before pushing, verify the target tag does not already exist; `latest` may only move to the exact digest of the newly verified immutable tag.
- OCI `org.opencontainers.image.revision` must equal the merged source revision used for the build.
