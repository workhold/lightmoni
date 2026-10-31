package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	moni "github.com/workhold/lightmoni/sdk/go"
)

func main() {
	endpoint := flag.String("endpoint", env("LIGHTMONI_ENDPOINT", "https://monitor.example.com"), "Agent or main service HTTP base URL")
	service := flag.String("service", env("LIGHTMONI_SERVICE", "example-go-api"), "service name")
	count := flag.Int("count", 20, "number of sample requests")
	flag.Parse()
	client, err := moni.New(moni.Config{Service: *service, Table: "http", Endpoint: *endpoint, Key: os.Getenv("LIGHTMONI_KEY"), Interval: time.Hour})
	if err != nil {
		fail(err)
	}
	requests, err := client.Counter("http.requests", moni.MetricOptions{Unit: "{request}"})
	if err != nil {
		fail(err)
	}
	duration, err := client.Histogram("http.duration", moni.MetricOptions{Unit: "ms", Boundaries: []float64{5, 10, 25, 50, 100, 250}})
	if err != nil {
		fail(err)
	}
	active, err := client.Gauge("http.active", moni.MetricOptions{Unit: "{request}"})
	if err != nil {
		fail(err)
	}
	for i := 0; i < *count; i++ {
		status := int64(200)
		if i%5 == 0 {
			status = 500
		}
		ctx, span := client.WithTable("app").StartSpan(context.Background(), "POST /payments", moni.Attributes{"route": "/payments"})
		attrs := moni.Attributes{"route": "/payments", "method": "POST", "status": status}
		requests.Add(ctx, 1, attrs)
		duration.Record(ctx, float64(5+i*2), attrs)
		active.Record(ctx, float64(i%4), nil)
		level := "info"
		if status == 500 {
			level = "error"
			span.SetError(fmt.Errorf("sample payment failed"))
		}
		client.Logger(ctx).WithTable("app").Log(level, "sample payment completed", moni.Attributes{"sample_id": i, "status": status})
		span.End()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := client.Shutdown(ctx); err != nil {
		fail(err)
	}
	fmt.Printf("Delivered %d sample requests for %s. Stats: %+v\n", *count, *service, client.Stats())
}
func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func fail(err error) { fmt.Fprintln(os.Stderr, err); os.Exit(1) }
