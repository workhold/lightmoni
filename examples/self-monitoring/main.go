package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/workhold/lightmoni/examples/self-monitoring/telemetry"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync/atomic"
	"syscall"
	"time"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:18480", "local demo HTTP address")
	traffic := flag.Bool("traffic", false, "generate a local order request every two seconds")
	flag.Parse()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	endpoint := os.Getenv("LIGHTMONI_ENDPOINT")
	if endpoint == "" {
		endpoint = "http://127.0.0.1:4318"
	}
	monitor, err := telemetry.New("mac-sdk-demo", endpoint, os.Getenv("LIGHTMONI_KEY"))
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	var orders atomic.Int64
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, "ok") })
	mux.HandleFunc("POST /orders", monitor.HTTP("/orders", func(w http.ResponseWriter, r *http.Request) {
		order := orders.Add(1)
		time.Sleep(20 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("fail") == "1" {
			monitor.Error(r.Context(), "order creation failed", map[string]any{"order_id": order, "reason": "demo simulated failure"})
			w.WriteHeader(500)
			json.NewEncoder(w).Encode(map[string]any{"ok": false})
			return
		}
		monitor.Info(r.Context(), "order created", map[string]any{"order_id": order})
		w.WriteHeader(201)
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "order_id": order})
	}))
	server := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	if *traffic {
		go func() {
			tick := time.NewTicker(2 * time.Second)
			defer tick.Stop()
			client := &http.Client{Timeout: 3 * time.Second}
			var calls int
			for {
				select {
				case <-ctx.Done():
					return
				case <-tick.C:
					calls++
					suffix := ""
					if calls%10 == 0 {
						suffix = "?fail=1"
					}
					request, _ := http.NewRequestWithContext(ctx, "POST", "http://"+*listen+"/orders"+suffix, nil)
					response, err := client.Do(request)
					if err == nil {
						response.Body.Close()
					}
				}
			}
		}()
	}
	go func() {
		<-ctx.Done()
		stop, c := context.WithTimeout(context.Background(), 5*time.Second)
		defer c()
		server.Shutdown(stop)
	}()
	log.Printf("SDK wrapper demo listening on http://%s (service mac-sdk-demo)", *listen)
	if err = server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Print(err)
		cancel()
	}
	stop, c := context.WithTimeout(context.Background(), 5*time.Second)
	defer c()
	if err = monitor.Shutdown(stop); err != nil {
		log.Printf("SDK shutdown incomplete: %v", err)
	}
}
