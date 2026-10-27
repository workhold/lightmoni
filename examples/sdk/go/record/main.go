package main

import (
	"context"
	moni "github.com/workhold/lightmoni/sdk/go"
	"os"
	"time"
)

func main() {
	client, err := moni.Init("database-api", "test")
	if err != nil {
		panic(err)
	}
	table := os.Getenv("LIGHTMONI_TABLE")
	if table == "" {
		table = "business"
	}
	// Call this after each database request. The SDK sends aggregated windows automatically.
	client.Record(table, "db.query.duration_ms", moni.Attributes{"key1": "telecom", "key2": "zhejiang"}, 128, 1)
	// Total spending 100 for 5 people; this does not describe their individual distribution.
	client.Record(table, "restaurant.spend", nil, 100, 5)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = client.Shutdown(ctx); err != nil {
		panic(err)
	}
}
