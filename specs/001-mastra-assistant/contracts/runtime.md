# Private worker contract v1

Go writes one start frame with system, config, canonical messages, summary/prefix, UI context, tool definitions and limits to stdin. JSON lines only; never argv/env credentials. Node writes typed frames to stdout:
- event {name,data}: allowlisted progress/text/usage only, sanitized.
- tool.request {id,name,input}: Go validates tool registration/input and invokes original tool under Principal and context; stdin receives tool.response {id,value,status}.
- checkpoint {messages}: normalized assistant and tool exchanges appended atomically before next step.
- compacted {summary,through}: successful compaction prefix; host checks whole-turn boundary.
- done or error {code}: exactly one terminal frame, no raw model error payload.

Go maps worker events to existing SSE types and adds session/turn IDs and sequence. Scanner/frame limits apply. Unknown frames, unexpected IDs, invalid checkpoints and EOF without done fail closed. Cancellation terminates worker, cancels current host tools and releases lock. Input is not a public API.

Existing /api/v1/assistant routes remain; ConfigView includes bounded limits and runtime:"mastra". Existing user/draft messages and events remain compatible. Usage is optional, compaction failure does not remove source history. All raw error text emitted by worker is replaced with an allowlisted host explanation.
