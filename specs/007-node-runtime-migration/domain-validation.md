# Node domain migration validation

Validated on 2026-10-17. Scope: `runtime/src/domains/**` and `runtime/test/domains*.test.ts`.

## API and persistence coverage

A static comparison of all non-test Go registrations in `internal/dashboards`, `internal/logs`, and `internal/alerts` against the Node registrations found **61 / 61 existing domain API routes**, with no missing methods or paths. Coverage includes dashboards and revisions; log sessions, aggregation, context, detail, tail and saved searches; alert rules, groups, channels, events, annotations and deliveries; on-call schedules, claims, incidents, silences and response statistics; traces, directory sources and public notification callbacks.

The modules retain the existing SQLite table names and body fields. System dashboard seed IDs remain durable: deleting or editing a built-in dashboard survives reopening. The old, unmodified Go goroutine panel is migrated once to Node active resources, with an event-loop delay panel appended below existing panels; other dashboard edits are preserved and the change records a new dashboard version. An edited or deleted runtime panel is not recreated.

Queries retain their existing `logs`, `alert`, and `interactive` source classifications. JSON parameter values and data frames preserve integer/decimal precision. RFC3339 ranges retain nanoseconds and reject impossible calendar dates.

## Controlled automated tests

```sh
npm --prefix runtime run typecheck
cd runtime
node --import tsx --test test/domains.test.ts test/domains-live.test.ts
```

Result: **30 passed, 0 failed, 1 optional live suite skipped**; TypeScript typecheck passed. The earlier 29-test set was extended with the existing-dashboard migration regression.

The controlled tests exercise:

- Dashboard optimistic concurrency, explicit overwrite, version history, copy ID remapping, durable seeds, query options, variable cycles, large numeric parameters and the Go-panel migration.
- Frozen log pagination, ownership and expiry; complete-range aggregation; exact typed filters; source-sequence context; nanosecond tail overlap; saved-search revisions.
- Exact rational thresholds, consecutive detections, grouped missing data, query-error health, encrypted credentials, rule revisions, annotations and response recovery.
- Primary/backup/fallback paging, acknowledgements, assignments and statistics; notification windows, DST rotations, silences and night accumulation.
- Evidence bindings and redaction; atomic directory contact updates with manual-contact preservation.
- Payloads and signatures for all 12 provider types, including the fixed Tencent Go/Python signing vector; controlled localhost SMTP, stable Message-ID, ambiguous paid-submission handling, voice callback deduplication, and signed/encrypted Feishu callbacks.
- Rechecking terminal incident state after asynchronous routing, plus independent evaluation and delivery workers so a slow query cannot block paging.

All provider HTTP requests in this suite use a controlled fetch implementation. SMTP uses a local test listener. No real SMS, voice, mail or chat provider receives a submission.

## Live ClickHouse integration

The repeatable opt-in suite is `runtime/test/domains-live.test.ts`:

```sh
cd runtime
LIGHTMONI_DOMAINS_URL=http://127.0.0.1:18885 \
  node --import tsx --test test/domains-live.test.ts
```

`LIGHTMONI_DOMAINS_USER` and `LIGHTMONI_DOMAINS_PASSWORD` override the isolated fixture account. The default fixture values are intended only for the temporary local QA environment. The suite is skipped unless a URL is explicitly supplied.

Executed against the isolated Node center on port 18885 with a real ClickHouse on port 18125 and state under `.local-dev/node-qa/state`. Result: **6 passed, 0 failed**, approximately 5.2 seconds (five domain checks plus their parent suite).

Verified end to end:

1. OTLP logs and traces enter ClickHouse, preserving integer attributes and source sequences above `2^53`.
2. Real log search freezes pages, independent aggregation counts the full range, exact numeric attribute filters match, source-sequence context reconstructs three rows, detail and tail return stored records, and saved searches persist.
3. Trace reconstruction returns the stored span and identifies its missing parent.
4. Dashboard updates retain version history, and the dashboard SQL returns the three ingested rows through the real query executor.
5. A real SQL rule fires, dispatches to a temporary localhost webhook, is claimed through the incident API, then recovers when its SQL condition changes with time.

## Background state and cleanup

Alert evaluation, response/delivery processing and directory synchronization have separate bounded timers. Shutdown clears their timers, aborts pending work and awaits the active promises. Startup changes uncertain in-flight deliveries to `unknown`, resets partial pending/recovery timing, and retains durable active incidents and acknowledged owners. Queue writes cannot turn a cancelled notification back into a sending job after asynchronous route validation, and answered voice receipts remain confirmed against late writers.

Controlled tests close their HTTP/SMTP listeners, abort background modules, close SQLite handles and remove temporary persistent-test directories. The live suite creates uniquely named `qa_domain_*` fixtures, removes its rules/groups/channels/dashboards/saved searches, disables its write key and closes its local webhook listener. The initial failed-run fixture key was also disabled. Ingested records and their uniquely named tables remain only in the disposable QA ClickHouse/state directory; no primary port-8080 data was modified.

## Verification boundaries

- Real provider accounts, paid SMS/voice delivery, remote mail and chat services were not exercised. Their contracts are covered by controlled payload/signature/receipt tests; live delivery used localhost only.
- ClickHouse was real and isolated. This validation did not run a Docker-based deployment or validate a Docker image.
- This report covers the domain slice. Agent packaging/collectors, authentication/OAuth, AI runtime, production release assets and the overall center lifecycle have their own migration validation.
