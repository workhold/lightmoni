# Validation Quickstart

From repository root:
```sh
PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests -v
python3 scripts/test-sdks.py --languages python
.local-dev/go/bin/go test -race ./sdk/go ./internal/agent ./internal/server
```
Tests cover real local HTTP configuration and telemetry, UID/QA/VIP decisions, shared child tables, atomic invalid-update fallback, retry identities, cancellation, polling while disabled/self-monitoring off, and isolated center/Agent configuration integration.

For a configured business instance, save table rules in 数据接入 → 数据表 → 日志上报规则; save stop selectors in 数据接入 → SDK 接入 → SDK 停报规则. The Python program should call refresh_config() before producing data if first-record enforcement matters. Defaults otherwise take effect after the first 30-second interval.
Expected: excluded/unmatched logs absent, QA/VIP retained, sampling metadata attached, metrics/traces unchanged; stopping clears unsent data, deleting selector resumes new data. Configuration errors appear in stats without exposing credentials. Use an isolated instance for automated integration; do not modify the user's active service.
