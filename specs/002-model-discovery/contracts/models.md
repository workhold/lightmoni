# Model discovery contract

## POST /api/v1/assistant/models
Authenticated administrator only. JSON <=16KiB:
```json
{"base_url":"https://api.example.com/v1","api_key":"temporary-key","use_saved_key":false}
```
Explicit api_key takes precedence. When empty and use_saved_key=true, saved config must exist with a nonempty key and the exact canonical base must match; otherwise 400 before contacting provider. With no reuse flag, no credential is sent. This endpoint never saves configuration or invokes a model.

200:
```json
{"base_url":"https://api.example.com/v1","protocol":"openai-chat-completions","models":[{"id":"example-model"}],"truncated":false}
```
protocol means the currently supported runtime, not a verified capability. Empty model array is valid. No metadata is used to infer model limits.

401 unauthenticated; 403 non-admin; 400 invalid input or saved-key mismatch; 500 config decryption/read failure; 502 provider auth (message identifies credential issue), no supported directory, malformed/oversized response, network error/redirect, rate-limit/server errors; 504 timeout. Errors expose only safe messages, never remote bodies, credential or raw request error.

Normalize input by removing terminal /chat/completions or /models and trailing slash; preserve custom and escaped paths. GET canonical <base>/models. A root-only base may try /v1/models following 404/405 or unrecognized response. No retries on auth or network failures. Saved-key reuse disables root-to-/v1 fallback because that would send a stored credential to a changed API base; only a fresh key or keyless request can use that fallback. 8 second total deadline, redirects forbidden, 1MiB per body, 500 returned IDs, <=200 bytes per ID.

## Config GET/PUT
ConfigView adds protocol="openai-chat-completions". PUT canonicalizes base_url. Existing empty-key preserve only applies at same canonical base; a changed base with stored key requires new api_key or clear_key=true. This check occurs before persistence.

## UI
Stable address/key/clear-key input starts discovery after 700ms; explicit 获取模型/刷新模型 retries. Closing and changing input aborts/invalidates requests. Success may normalize API address, never changes model text or budgets. Model field accepts both options and arbitrary manual text. Protocol displayed as fixed supported value with clear model-list capability limits.
