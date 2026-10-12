package main

import (
	"context"
	"github.com/lightmoni/lightmoni/internal/alerts"
	"github.com/lightmoni/lightmoni/internal/assistant"
	"github.com/lightmoni/lightmoni/internal/dashboards"
	"github.com/lightmoni/lightmoni/internal/logs"
	"github.com/lightmoni/lightmoni/internal/server"
	"log"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	s, e := server.New(ctx, server.Config{DataDir: env("LIGHTMONI_DATA", ".lightmoni"), CHURL: env("LIGHTMONI_CH_URL", "http://127.0.0.1:18123"), CHUser: env("LIGHTMONI_CH_USER", "lightmoni"), CHPassword: env("LIGHTMONI_CH_PASSWORD", "lightmoni_test_password"), ExternalURL: env("LIGHTMONI_EXTERNAL_URL", "http://localhost:8080")})
	if e != nil {
		log.Fatal(e)
	}
	defer s.DB.Close()
	slog.SetDefault(slog.New(&server.RuntimeLogHandler{Console: slog.NewTextHandler(os.Stderr, nil), Monitor: s.Runtime, Secrets: []string{env("LIGHTMONI_CH_PASSWORD", "lightmoni_test_password")}}))
	ai, e := assistant.New(s.Dependencies())
	if e != nil {
		log.Fatal(e)
	}
	ai.Register(s.API)
	dash, e := dashboards.New(s.Dependencies())
	if e != nil {
		log.Fatal(e)
	}
	dash.Register(s.API)
	if e = dash.SeedSystemDashboards(ctx); e != nil {
		log.Fatal(e)
	}
	logsModule, e := logs.New(s.Dependencies())
	if e != nil {
		log.Fatal(e)
	}
	logsModule.Register(s.API)
	alertsModule, e := alerts.New(s.Dependencies())
	if e != nil {
		log.Fatal(e)
	}
	alertsModule.Register(s.API)
	go alertsModule.Run(ctx)
	go s.RunAgentTelemetry(ctx)
	go s.RunRuntime(ctx)
	httpServer := &http.Server{Addr: env("LIGHTMONI_ADDR", "127.0.0.1:8080"), Handler: s.Handler(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		<-ctx.Done()
		stop, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		_ = httpServer.Shutdown(stop)
	}()
	log.Printf("LightMoni listening on %s", httpServer.Addr)
	if e = httpServer.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
}
