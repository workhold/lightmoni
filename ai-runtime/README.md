# LightMoni Mastra worker

Private, host-managed Node >=22.13 runtime. Go starts `dist/runner.js` for each authenticated turn; this worker has no HTTP listener or business database. Mastra executes the model/tool loop; registered business tools round-trip over private JSON lines and execute under the original Go Principal.

```sh
npm ci
npm run build
npm run typecheck
npm test
```

From repository root, build the worker before `go test -race ./internal/assistant` to enable actual Mastra integration fixtures. Production Go always uses Mastra; the historical Go parser/loop is test-only. Docker packages the worker automatically.

The host owns source history and compacted prefixes. No separate Mastra Memory database is used. Context is estimated conservatively and checked before every provider call; usage comes only from raw provider counts. Cancellation closes the scoped process/model connections and cancels Go tools.

See [feature contract](../specs/001-mastra-assistant/contracts/runtime.md), [design](../specs/001-mastra-assistant/plan.md) and [verification](../specs/001-mastra-assistant/verification.md). Do not launch this entry as a public API or log private stdin frames.
