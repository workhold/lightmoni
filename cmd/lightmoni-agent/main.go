package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/lightmoni/lightmoni/internal/agent"
)

func main() {
	if err := execute(os.Args[1:]); err != nil {
		slog.Error("agent stopped", "error", err)
		os.Exit(1)
	}
}
func execute(args []string) error {
	command := "run"
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		command = args[0]
		args = args[1:]
	}
	if command == "version" {
		fmt.Println(agent.Version)
		return nil
	}
	flags := flag.NewFlagSet(command, flag.ContinueOnError)
	path := flags.String("config", "/etc/lightmoni-agent/config.json", "JSON configuration path")
	action := flags.String("action", "list", "quarantine operation: list, retry, discard")
	id := flags.String("id", "", "quarantined batch ID")
	confirm := flags.Bool("confirm-data-loss", false, "explicitly discard an accepted batch")
	expectedDir := flags.String("require-data-dir", "", "require a specific data directory for system-service installation")
	endpoint := flags.String("endpoint", "", "server reporting address")
	groupID := flags.String("group-id", "", "initial agent group")
	keyStdin := flags.Bool("key-stdin", false, "read the reporting key from stdin")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if command == "configure" {
		cfg := agent.DefaultConfig()
		if _, err := os.Stat(*path); err == nil {
			loaded, err := agent.LoadConfig(*path)
			if err != nil {
				return err
			}
			cfg = loaded
		} else if !os.IsNotExist(err) {
			return err
		}
		if *endpoint != "" {
			cfg.Endpoint = *endpoint
		}
		if *groupID != "" {
			cfg.GroupID = *groupID
		}
		if *expectedDir != "" {
			cfg.DataDir = *expectedDir
		}
		if *keyStdin {
			raw, err := io.ReadAll(io.LimitReader(os.Stdin, 4097))
			if err != nil {
				return err
			}
			if len(raw) > 4096 {
				return fmt.Errorf("reporting key is too long")
			}
			cfg.Key = strings.TrimSpace(string(raw))
		}
		if err := agent.SaveConfig(*path, cfg); err != nil {
			return err
		}
		fmt.Println("reporting configuration saved")
		return nil
	}
	cfg, err := agent.LoadConfig(*path)
	if err != nil {
		return err
	}
	switch command {
	case "check":
		if *expectedDir != "" && cfg.DataDir != *expectedDir {
			return fmt.Errorf("this system service requires data_dir=%s", *expectedDir)
		}
		fmt.Println("configuration valid")
		return nil
	case "status":
		client := &http.Client{Timeout: 5 * time.Second}
		req, err := http.NewRequest(http.MethodGet, "http://"+cfg.Listen+"/status", nil)
		if err != nil {
			return err
		}
		if cfg.LocalToken != "" {
			req.Header.Set("Authorization", "Bearer "+cfg.LocalToken)
		}
		response, err := client.Do(req)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			return fmt.Errorf("status HTTP %d", response.StatusCode)
		}
		_, err = io.Copy(os.Stdout, io.LimitReader(response.Body, 1<<20))
		return err
	case "quarantine":
		queue, err := agent.OpenQueue(cfg)
		if err != nil {
			return err
		}
		defer queue.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		switch *action {
		case "list":
			items, err := queue.Quarantined(ctx)
			if err != nil {
				return err
			}
			return json.NewEncoder(os.Stdout).Encode(items)
		case "retry":
			if *id == "" {
				return fmt.Errorf("id required")
			}
			return queue.Resolve(ctx, *id, false)
		case "discard":
			if *id == "" || !*confirm {
				return fmt.Errorf("discard requires --id and --confirm-data-loss")
			}
			return queue.Resolve(ctx, *id, true)
		default:
			return fmt.Errorf("unknown quarantine action")
		}
	case "run":
		a, err := agent.New(cfg)
		if err != nil {
			return err
		}
		defer func() {
			if err := a.Close(); err != nil {
				slog.Warn("agent shutdown incomplete", "error", err)
			}
		}()
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		slog.Info("agent started", "agent_id", a.ID(), "listen", cfg.Listen)
		return a.Run(ctx)
	default:
		return fmt.Errorf("unknown command %q; use run, configure, check, status, quarantine or version", command)
	}
}
