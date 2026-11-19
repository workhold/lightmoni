# Research and current behavior

- `OperationsPage.load` currently awaits `/ops/overview` and optional `/ops/inventory` together before setting any list data. `/ops/overview` serializes every public resource, upgrade projection, machines, agents and runs.
- `GET /ops/resources?kind=` already limits resources by kind but returns status. An opt-in config projection can reduce response size without changing default callers.
- `ResourceFields` already supports ACME, self signed and uploaded PEM text. `validateCertificate` checks 128 KiB chain and 64 KiB key, matches the key and domains, and `publicCertificate` removes material.
- Website bindings already persist `certificate_id`; the selection lives in the domain section, while the screenshot's HTTPS accordion contains only redirects, HTTP/2 and TLS protocols.
- No new certificate source, provider import or storage migration is needed for the requested selection workflow.
