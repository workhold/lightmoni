package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lightmoni/lightmoni/internal/agent"
)

func configureInput(t *testing.T, input string, args ...string) error {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "stdin")
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	file.WriteString(input)
	file.Seek(0, 0)
	previous := os.Stdin
	os.Stdin = file
	defer func() { os.Stdin = previous }()
	return execute(append([]string{"configure"}, args...))
}

func TestConfigureCreatesPrivateConnectionAndPreservesLocalState(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "config", "config.json")
	data := filepath.Join(dir, "queue")
	if err := configureInput(t, "lm_initial_secret\n", "--config", path, "--endpoint", "https://monitor.example.com", "--group-id", "production", "--key-stdin", "--require-data-dir", data); err != nil {
		t.Fatal(err)
	}
	cfg, err := agent.LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Endpoint != "https://monitor.example.com" || cfg.Key != "lm_initial_secret" || cfg.GroupID != "production" || cfg.DataDir != data {
		t.Fatal("connection settings were not saved")
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal("key configuration is not private")
	}
	cfg.LocalToken = "keep-local-token"
	cfg.MaxQueueBatches = 123
	cfg.ProcessNames = []string{"nginx"}
	if err = agent.SaveConfig(path, cfg); err != nil {
		t.Fatal(err)
	}
	if err = execute([]string{"configure", "--config", path, "--group-id", "staging"}); err != nil {
		t.Fatal(err)
	}
	updated, err := agent.LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Key != cfg.Key || updated.DataDir != data || updated.LocalToken != cfg.LocalToken || updated.MaxQueueBatches != 123 || updated.GroupID != "staging" {
		t.Fatal("regroup replaced local state")
	}
	before, _ := os.ReadFile(path)
	if err = configureInput(t, strings.Repeat("k", 4097), "--config", path, "--key-stdin"); err == nil {
		t.Fatal("unbounded key accepted")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("invalid configure overwrote existing credentials")
	}
}
