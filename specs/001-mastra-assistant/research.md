# Research decisions

## Agent integration
Decision: use Mastra Agent.stream with createTool and Zod conversion of host schemas. Version parity with local Doca reduces API uncertainty. Inspect installed types and verify with an actual fixture rather than copying Doca source.
Alternative: Pi Agent would require a different tool/event adapter; selected Mastra explicitly requested.

## Host boundary
Decision: one Node worker per turn via private pipes, created by Go exec.CommandContext. No public AI endpoint or callback URL, no shell execution, no credentials in argv. Tools round-trip to Go and retain original Principal/context. Alternative: persistent network sidecar adds deployment/authentication overhead for the current four-tool scope.

## History
Decision: canonical messages/events stay in Go SQLite; compacted prefix index and summary are additive. Fit complete user-led rounds, retain latest request, tool-free summarizer reduces older prefix. Conservative byte estimation bounds requests with slack; it is not exact model tokenization. Failed summary leaves durable prefix unchanged. Alternative: independent Mastra Memory duplicates session ownership/storage unnecessarily.

## Operability
Decision: pin package versions, build TypeScript worker into image, configure executable/entry path with LIGHTMONI_AI_NODE / LIGHTMONI_AI_RUNNER. No fallback to the old production loop when runtime missing: return actionable failure.

## Doca reference
Inspected apps/server/src/services/ai/{runner,history,memory,delivery}.ts. Actual design confirms host-owned job/permission/receipt state around Mastra. Current Doca package/root license AGPL-3.0-only; implementation here is original, no current source copied. Historical migration notices remain associated with the original older import, not newly claimed permissions.
