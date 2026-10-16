# Protocol contract

## Configuration
Config.protocol is one of openai-chat-completions | openai-responses | anthropic-messages | google-generative-ai. Omitted/blank on old input means Chat; auto/unknown rejected400 before persistence. ConfigView returns stored concrete protocol. Changing only protocol on exact canonical base may keep saved key. Changed base still new key or clear_key required.
Canonical URL retains escaped tenant paths and current validation; additionally strip terminal /responses, /messages, and Gemini /models/{id}:generateContent or :streamGenerateContent, along with existing /chat/completions and /models. Model field remains independent; do not infer protocol from name.

## POST /api/v1/assistant/models
Existing admin-only endpoint. Input {base_url, api_key?, use_saved_key?, protocol?:auto|concrete}, strict16KiB. Omitted protocol=auto. Unknown protocol400 before provider.
200 extends prior fields:
```json
{"base_url":"https://example.com/v1","protocol":"openai-chat-completions","protocol_options":["openai-chat-completions","openai-responses"],"protocol_source":"catalog","requires_confirmation":true,"capabilities_verified":false,"models":[{"id":"model"}],"truncated":false}
```
Manual protocol returns itself, source manual, confirmation false. Auto official OpenAI host recommends Responses; official Anthropic/Google host or explicit complete endpoint path recommends corresponding native protocol. Unknown OpenAI-compatible directories cannot distinguish Chat vs Responses: show candidates and require concrete choice. A `models[].name` envelope alone is not proof of Gemini because gateways may reuse that shape; native Gemini is recommended only when the Google profile or a trusted Google URL/path succeeds. A successful Anthropic profile supplies the native recommendation; no capability claim.
Authentication profiles: OpenAI Bearer, Anthropic x-api-key + anthropic-version:2023-06-01, Google x-goog-api-key. Never key in URL/query. Auto hint first, otherwise OpenAI then Anthropic then Google on authentication/unsupported responses. Explicit/manual and trusted URL hint query only relevant profile. At most6 same-origin GETs total and8s overall; reject redirects, max1MiB each. Each profile may use at most one root version candidate: /v1 generally, /v1beta for Google; only fresh input or no key, never saved-key reuse. Preserve custom paths, do not scan vendors.
Directory: OpenAI/Anthropic data[].id; Anthropic optional limit=500 and has_more -> truncated; Google pageSize=500/models[].name strip models/, supportedGenerationMethods excludes explicit embed-only entries, nextPageToken -> truncated. No page token following. IDs≤200 bytes no controls, sort/dedup/cap500; optional human display labels sanitized and bounded.
Failure stays400/401/403/500/502/504 existing semantics, add error codes where useful: credentials_rejected, directory_unsupported, provider_unavailable, timeout, saved_key_mismatch. UI must translate to actionable Chinese without remote body leakage. Query never saves or generates.

### Discovery matrix and address repair
`protocol=auto` probes a URL hint first, otherwise profiles in OpenAI-compatible, Anthropic and Google order. Each profile may try the supplied canonical base and one same-origin conventional version candidate (`/v1` or `/v1beta`) when the directory path is unsupported; a fresh key may be used for those candidates, while a saved key remains bound to the exact canonical base. A candidate that returns 401/403 remains an authentication result; it must not be presented as a successful directory. The response `base_url` is the candidate that actually served the directory.

The repair scope is deliberately bounded: trim slashes and known generation/catalog suffixes, preserve tenant paths, and try the standard version suffix. It does not guess arbitrary vendor prefixes, domains, keys or model names. A directory success proves only catalog access; it does not prove generation, tool use or model context limits.

## POST /api/v1/assistant/test-connection
Admin-only, strict 16KiB JSON input:
```json
{"base_url":"https://example.com/v1","api_key":"optional","use_saved_key":false,"protocol":"openai-chat-completions","model":"model-id"}
```
`protocol` must be concrete and `model` non-empty. The endpoint applies the same canonical URL and saved-key address checks as configuration/discovery, then invokes the existing Mastra runtime with no tools, a fixed short prompt, `max_input_tokens=4096`, `max_output_tokens=256`, and a short timeout. Runtime frames and model text are discarded; no session or configuration is written.

Success returns `{ "ok": true, "base_url": "...", "protocol": "...", "model": "...", "latency_ms": 123 }`. Invalid input or saved-key mismatch is 400, timeout is 504, and network/provider/runtime failure is a generic 502. Provider response bodies, API keys and generated text never appear in the response.

## Runtime
OpenAI Chat /chat/completions via existing SDK; Responses /responses via createOpenAI.responses; Anthropic /messages via createAnthropic; Gemini /models/{model}:streamGenerateContent?alt=sse via createGoogleGenerativeAI. Custom base/version prefixes preserved, Gemini model IDs tolerate single models/ prefix. Native packages pinned to matching model-provider interface.
All share Mastra/tool authority/budgets/history/cancel. Responses stateless store:false. Raw usage fields mapped per protocol including Anthropic additive cache input and Gemini output thoughts; missing raw fields stay unknown. Model errors fixed codes/no SDK error echo.

## UI
Independent full-size 获取模型 button next to/after address+key, always visible. Protocol Select: 自动识别 plus4 concrete choices. Stable input auto queries; explicit retry available; connection/protocol edits cancel previous work. Auto recommendation displays source and caveat; ambiguous OpenAI directory requires choosing Chat or Responses before save. Query failure preserves manual model; choose concrete protocol to save without directory. Do not overwrite manual model or budgets. Keep scrollable modal/footer.
Old user tab5 is not reloaded because it has unsaved fields; fresh final tab visible and retained, with re-entry of Key by user (no extraction).

## Native durable metadata
Neutral ToolCall may carry `provider_options:Record<string,Record<string,string>>`; Message may carry `provider_state:{type:"reasoning"|"text",text?:string,provider_options:Record<string,Record<string,string>>}[]`. Allowlisted keys are `google.thoughtSignature` and `openai.itemId` / `openai.reasoningEncryptedContent` only. A text record retains the original visible answer slice to associate its signature with that exact native part; reasoning records may not carry text. Runtime reconstructs SDK providerOptions and native parts when replaying. Persist only ciphertext/signatures/item IDs plus already-public answer slices, never hidden plaintext reasoning. Go stores and passes through bounded allowlisted state, but excludes provider_state/provider_options from browser-facing session responses. Each opaque string≤256KiB, aggregate encoded provider metadata≤1MiB per checkpoint and resulting stored history, with existing2MiB session/NDJSON limits. Metadata contributes to history/context limits; oversized state is an explicit failure, not silent dropping. Fixtures verify Gemini text/tool signatures and Responses ciphertext across a second fresh worker.
