# Data model

Session gains optional summary:string and summary_through:int (exclusive original message index). Old sessions default empty/0. Original messages remain source truth for UI; model input is summary + messages[summary_through:]. Commit new summary only after successful generation, valid boundaries and size limits.

Config gains max_input_tokens (default 32000, 4096–128000), max_output_tokens (4096, 256–16384), max_steps (8, 1–12). Missing fields normalize; plaintext API key stays encrypted at rest and absent from ConfigView.

turn.usage event stores reported input_tokens, output_tokens, total_tokens, with phase execute/compact. Counts are not inferred when unavailable. context.compacting/context.compacted events carry no raw prompt or secret. Runtime history checkpoints contain normalized assistant/tool messages only.

Turn states: started → step/tool/text events → exactly one completed/failed/cancelled. Existing per-session active lock and ownership remain. Browser disconnect cancels, source checkpoint survives; no automatic background replay.

Instance concurrency defaults to 4; each session still permits only one active turn. Busy returns 429 before user messages are appended.
