// A real Go SDK → local Agent example for the logs exploration acceptance path.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	moni "github.com/workhold/lightmoni/sdk/go"
)

func main() {
	endpoint := flag.String("endpoint", env("LIGHTMONI_ENDPOINT", "https://monitor.example.com"), "local Agent HTTP endpoint")
	count := flag.Int("count", 240, "number of logs")
	run := flag.String("run", env("LIGHTMONI_LOGS_RUN", "logs-demo"), "searchable run marker")
	flag.Parse()
	c, err := moni.New(moni.Config{Service: "logs-go-demo", Table: env("LIGHTMONI_LOGS_TABLE", "acceptance"), Endpoint: *endpoint, Key: os.Getenv("LIGHTMONI_KEY"), Interval: time.Hour})
	if err != nil {
		fail(err)
	}
	for i := 0; i < *count; i++ {
		ctx, span := c.StartSpan(context.Background(), "payment.process")
		status := 200
		level := "info"
		body := fmt.Sprintf("%s Go payment %03d completed 中文", *run, i)
		if i%5 == 0 {
			status = 500
			level = "error"
			body += "\nPaymentError: payment rejected\n  at payment.process (payments.go:42)"
			span.SetError(fmt.Errorf("payment rejected"))
		}
		if i == 0 {
			body += "\n" + strings.Repeat("long-log-line: original stack and UTF-8 内容\n", 300)
		}
		c.Log(ctx, level, body, moni.Attributes{"run": *run, "request_id": fmt.Sprintf("go-%03d", i), "status": status, "retryable": status == 500, "empty": "", "route": "/payments"})
		span.End()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := c.Shutdown(ctx); err != nil {
		fail(err)
	}
	fmt.Printf("Go delivered %d logs for %s; stats: %+v\n", *count, *run, c.Stats())
}
func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
