# Contracts

## DNS zone sync
A successful remote sync clears `status.last_error`; failed provider calls retain a safe provider error code.

## PUT /api/v1/connection-credentials/:id
`name` is always required. `method` is not accepted. Optional `secret` rotates the stored password/private key using the existing method. SSH key rotation rejects an active duplicate fingerprint. Secrets are never returned.

## Docker verification
A read-only status check reports `failed/docker_install_not_started` when the remote operation directory is absent. `running` continues to fence unrelated operations; `failed` releases the historical installation fence.
