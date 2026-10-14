package moni

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
)

// Compare independent Python and Go decisions, including typed scalar tokens,
// UTF-8 hashing, exponent expansion and per-event fallback for missing keys.
func TestPythonSamplingMatchesGo(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("Python 3.9+ is required for cross-language reporting verification")
	}
	root, err := filepath.Abs("../../sdk/python")
	if err != nil {
		t.Fatal(err)
	}
	policy := LogSamplingPolicy{Key: "attr:uid", Rules: []LogRule{{Name: "cohort", Rate: .5, Conditions: []LogCondition{}}}, Exclude: []LogExcludeRule{}}
	values := []any{"0", "1", "42", "100", "测试", "vip-user", true, false, int64(0), int64(1), int64(42), 42.0, 1.5, 1e-7, 1e20, 1e200, "9007199254740993", int64(9007199254740993), -1.25}
	var inputs []map[string]any
	var expected []bool
	add := func(attrs Attributes, event string) {
		record := Attributes{"event_id": event}
		keep, _, _ := policy.decide("web", record, attrs, nil)
		expected = append(expected, keep)
		inputs = append(inputs, map[string]any{"policy": policy, "table": "web", "record": record, "attributes": attrs})
	}
	for _, value := range values {
		add(Attributes{"uid": value}, "fixed:1")
	}
	for i := 1; i <= 50; i++ {
		attrs := Attributes{}
		if i%2 == 0 {
			attrs["uid"] = ""
		}
		add(attrs, "golden:"+strconv.Itoa(i))
	}
	raw, err := json.Marshal(inputs)
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(python, "-c", `import json, sys
from lightmoni.sampling import copy_policy, sample_log
rows = json.load(sys.stdin)
print(json.dumps([sample_log(copy_policy(row['policy']), row['table'], row['record'], row['attributes'], {})[0] for row in rows]))`)
	command.Env = append(os.Environ(), "PYTHONPATH="+root)
	command.Stdin = bytes.NewReader(raw)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("Python reporting decisions: %v: %s", err, output)
	}
	var actual []bool
	if err := json.Unmarshal(output, &actual); err != nil {
		t.Fatal(err)
	}
	if len(actual) != len(expected) {
		t.Fatalf("Python returned %d decisions, want %d", len(actual), len(expected))
	}
	for i, keep := range expected {
		if actual[i] != keep {
			t.Fatalf("cross-language cohort differs for vector %d: Go=%v Python=%v input=%v", i, keep, actual[i], inputs[i])
		}
	}
}
