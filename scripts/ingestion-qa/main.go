package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"github.com/lightmoni/lightmoni/internal/alerts"
	"github.com/lightmoni/lightmoni/internal/dashboards"
	"github.com/lightmoni/lightmoni/internal/server"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
)

func main() {
	dir, err := os.MkdirTemp("", "lightmoni-table-key-qa-")
	if err != nil {
		log.Fatal(err)
	}
	defer os.RemoveAll(dir)
	chServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"meta":[],"data":[]}`))
	}))
	defer chServer.Close()
	service, err := server.New(context.Background(), server.Config{DataDir: dir, CHURL: chServer.URL, CHUser: "qa", ExternalURL: "http://127.0.0.1:18882"})
	if err != nil {
		log.Fatal(err)
	}
	defer service.DB.Close()
	dash, err := dashboards.New(service.Dependencies())
	if err != nil {
		log.Fatal(err)
	}
	dash.Register(service.API)
	alertModule, err := alerts.New(service.Dependencies())
	if err != nil {
		log.Fatal(err)
	}
	alertModule.Register(service.API)
	service.Auth.ExternalURL = "http://127.0.0.1:5178"
	db := service.DB
	for _, table := range []string{"web", "business", "host", "probe"} {
		_, err = db.Exec("INSERT INTO catalog(id,name,logical_name,kind,metric_type,columns_json,services_json)VALUES(?, ?, ?, 'log','','[]','[]')", "log_"+table, "log_"+table, table)
		if err != nil {
			log.Fatal(err)
		}
	}
	sum := sha256.Sum256([]byte("qa-legacy-secret"))
	_, err = db.Exec("INSERT INTO ingest_keys(id,name,token_hash,created_at)VALUES('qa-legacy','旧 Key 待配置',?,'2026-10-10')", hex.EncodeToString(sum[:]))
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("QA backend on 127.0.0.1:18882; isolated temporary SQLite; ClickHouse writes stubbed")
	server := &http.Server{Addr: "127.0.0.1:18882", Handler: service.Handler()}
	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt)
	defer signal.Stop(interrupt)
	go func() {
		<-interrupt
		_ = server.Shutdown(context.Background())
	}()
	if err = server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
