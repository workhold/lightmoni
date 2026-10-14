# Data Model

- DiscoveryInput: base_url (HTTP(S), <=2048 bytes, no userinfo/query/fragment); api_key (optional <=4096, no control characters); use_saved_key (boolean, false by default).
- DiscoveryView: base_url (canonical successful base), protocol (fixed openai-chat-completions), models (array of {id}, sorted unique names <=200 bytes without control chars), truncated (boolean).
- ConfigView adds protocol; Config storage format unchanged. Save normalizes base and compares it against stored canonical base before preserving secret.
- UI: idle -> waiting -> loading -> success/error. Any connection edit or close invalidates request and aborts it. Model text is independent of query state and never changed by discovery. Successful normalized URL becomes form value, not persistent state.

Stored-key reuse never probes a versioned fallback base. Root fallback is permitted for freshly entered credentials or keyless requests.
