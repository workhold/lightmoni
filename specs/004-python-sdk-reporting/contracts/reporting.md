# Python SDK Reporting Contract

## Public API
Client(service, table, endpoint=..., key='', self_telemetry=True, *, log_sampling=None, disabled=False, remote_config=True, config_endpoint=None, config_key=None, config_interval=30, resource=None, instance_id=None, **limits).
Existing five positional parameters and limit names remain valid. config_interval is finite and >=1 second; resource uses existing scalar OTLP attributes, reserved service identity cannot be overwritten. instance_id defaults to UUID; explicit identity must be a nonempty bounded string.
- refresh_config(timeout=5): synchronous bounded GET, requires enabled remote_config; returns after complete apply or raises credential-free error; timeout positive, capped at five seconds. Concurrent calls serialize within caller deadline.
- update_log_sampling(policies): atomically replace deep-validated local map; remote map takes precedence per table.
- set_reporting_enabled(enabled): local switch; cannot override remote stop.
- stats(): adds sampled_out_logs, unmatched_logs, excluded_logs, disabled_records, reporting_disabled, config_revision, config_error. Controlled ignores are not dropped_records or persistent delivery errors.

## Existing HTTP API
GET {config_endpoint}/v1/sdk-config; config_endpoint=None uses endpoint, an empty config_endpoint is invalid. config_key=None uses the current key; an explicit empty config_key sends no authentication. A nonempty resolved key uses Authorization: Bearer {key}. No redirects. Response is existing SDKConfig JSON; body <=1 MiB, exchange and decode use a budget <=5 seconds. Blocking system DNS resolution can exceed the wall-clock budget. Explicit update_key changes following requests unless separate config_key is set. No response bodies/URLs/keys in errors.
HTTP(S) proxy environment settings and no_proxy retain their existing role: HTTP requests use absolute URLs, HTTPS origins use CONNECT through an HTTP proxy. HTTP origins may use a TLS proxy. TLS inside a TLS proxy tunnel is unsupported by the standard-library transport and rejected before plaintext credentials could be sent.
Default first automatic refresh occurs after config_interval; explicit refresh is required before business production when first-record enforcement matters. Polling continues while disabled and with self_telemetry=False. Shutdown stops polling; late responses cannot apply.

## Decisions
Exclusions run first, conditions AND, matched rules choose maximum rate. No policy => retain unchanged log. Configured policy with no matched rule => ignore, rules=[] => ignore all, conditions=[] => matches all, rate=0 => controlled ignore. There is no implicit ERROR/FATAL retention.
Sampling token: string s:, bool b:true/b:false, numeric n:decimal without exponent/trailing fractional zeros. FNV-1a hash UTF-8 bytes of lightmoni-log-rules + NUL + table + NUL + field + NUL + token; 32-bit avalanche constants 0x85ebca6b/0xc2b2ae35, threshold hash/2**32 < rate. Missing/null/empty key falls back to event_id; event_id is instance_id:monotonic source_sequence.
Retained policy-controlled logs replace caller lightmoni.sampling.rate/weight/rule with authoritative rate, 1/rate and matched name (or matched), and source_id/source_seq with the SDK identity used for event selection. No-policy logs keep existing attributes unchanged. System self-telemetry bypasses business policy. Metrics and spans bypass log policies.

## Stop and retry
Disable is atomic for records/series/queue; pending counters reset, delivery generation invalidated. Requests waiting for response and retry sleeps are cancellable; a request already committed may be received. DNS resolution/OS connect cannot guarantee instantaneous cancellation, but cancellation is checked before sending after connect.
Span captures generation and disabled-at-start; end after a disable transition or start while disabled is ignored even after resume. A late old delivery result cannot mutate new queue state. Policy-only change never rewrites queued payload/id/timestamp. Rejected/partial OTLP behavior remains unchanged.
Concurrent root/child shutdown calls share one final flush; followers wait within their own deadline without cancelling the owner. Failed final delivery remains visible rather than being reported as a successful close.
