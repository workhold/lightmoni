# Research
- Decision: concrete four-protocol enum; auto only for discovery/UI. Rationale: stored behavior must remain deterministic; legacy configs default Chat. Alternatives: automatic runtime retries can spend tokens and silently switch behavior.
- Decision: package versions openai4.0.66/anthropic4.0.53/google4.0.69, matched provider4.0.14/utils5.0.40 from exact tarballs. Native factories share model proxy/budgets/Mastra tools. Reference packages in Doca only; no current AGPL code copying.
- Decision: read-only automatic catalog detection with specific header profiles and official URL/full endpoint hints; the successful profile is the protocol evidence, while an unknown OpenAI-compatible catalog (including a reused `models[].name` envelope) requires manual Chat/Responses choice. No model-name inference or generation calls. Rationale: `/models` and its response shapes are commonly reused by gateways.
- Decision: request up to500 native items and return truncation when more pages exist rather than unbounded pagination. Gemini IDs strip models/ and exclude explicit embedding-only methods.
- Decision: preserve bounded root fallback for fresh/keyless input, once per candidate protocol profile to conventional /v1 or /v1beta according to hint/manual protocol; saved key never crosses API base. Unknown auth profiles retry same base only within global request/deadline limits.
- Decision: keep the discovery path deliberately small and borrow CC Switch's candidate-based model fetch rather than vendor-specific integration. The main flow tries the supplied base and a conventional version suffix, preserves manual model input, and may later add a custom models URL without changing the protocol contract. A 401/403 is an authentication result, not proof that another path is valid; fresh-key path repair must retain that error if all candidates fail.
- Decision: add an explicit test-connection action that reuses the Mastra runtime for a real, minimal request. Directory refresh remains read-only; the test action is never automatic and may consume provider quota.
- Decision: usage reads original provider fields with protocol-aware cache/thought totals, unknown missing fields. Retain cancellation/error sanitation and stateless Responses store:false.
- Observed user tab5 still runs old bundle with unsaved base/key; preserve it and deliver new tab. No secret extracted. Huayan GET models without key returned401; protocol remains unknown.

Official references read:
- OpenAI https://developers.openai.com/api/docs/guides/migrate-to-responses and https://developers.openai.com/api/reference/resources/responses/methods/create/
- OpenAI models https://developers.openai.com/api/reference/resources/models/methods/list
- Anthropic https://platform.claude.com/docs/en/api/models/list
- Gemini https://ai.google.dev/api/models and https://ai.google.dev/gemini-api/docs/api-key
All design unknowns resolved by two research agents and exact installed/tarball types.
