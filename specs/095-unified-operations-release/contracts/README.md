# Release Contract

- release.json binds source_revision, fixed tag, per-platform image IDs/config/rootfs and registry index/child digests. No secrets.
- Production compare-and-swap requires the actual current container image ID and configured image to match the recorded baseline immediately before switch. Backups stay protected on server; public receipt contains only paths/identities/counts/status.
- Expected executor capabilities include operations.platform.image-refresh.v1 and the health/readiness capability from PR97. Old executors cannot silently accept richer payloads.
- Center/Agent outboxes retain stable event identities and cursors. Historical unknown operations remain unknown after documented reconciliation.
- Acceptance requires three increasing observation periods, actual site requests, app/site scopes and matching SDK deployment identity. Interrupted or failed samples remain in evidence.
