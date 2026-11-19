# Operations resource configuration read

`GET /api/v1/ops/resources?kind=application|website&view=config`

- Requires the existing operations administrator authorization.
- Preserves the existing `{resources, limit, offset, next_offset, total}` envelope, pagination bounds, ordering and cluster filtering.
- Each resource retains public metadata and sanitized `spec`; `status` is omitted. Secret certificate material remains redacted through the existing public projection.
- Omitting `view` returns the original full resource representation. Unsupported `view` values return 400.
- The client then reads the unchanged `GET /api/v1/ops/overview` for authoritative status, associated resources, agents, machines and runs. On failure it retains displayed configuration and shows a status read error.

Website saving continues to use `spec.bindings[i].certificate_id`; uploaded certificates continue through the existing certificate resource POST/PUT and issue/import path. File selection has no new endpoint.
