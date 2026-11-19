# Data model

No persisted model changes.

- `Resource` config read: same public ID, kind, name, revision and sanitized spec as the existing list; observed `status` is omitted for `view=config`.
- Client pending state: local only; never persisted or sent to server. Full overview replaces it with real observed status.
- `Website.spec.bindings[i].certificate_id`: existing per binding reference.
- `Certificate.spec`: existing encrypted uploaded PEM material or ACME/self signed settings. Public responses retain only `has_certificate` and `has_private_key` booleans.
