package main

import (
	"context"
	moni "github.com/lightmoni/lightmoni/sdk/go"
	"log"
	"math"
	"os"
	"time"
)

func main() {
	endpoint := os.Getenv("LIGHTMONI_ENDPOINT")
	if endpoint == "" {
		endpoint = "http://127.0.0.1:14318"
	}
	c, e := moni.New(moni.Config{Service: "precision-acceptance", Table: "precision", Endpoint: endpoint, Key: os.Getenv("LIGHTMONI_KEY"), Interval: time.Hour})
	if e != nil {
		log.Fatal(e)
	}
	g, e := c.Gauge("precision.gauge", moni.MetricOptions{})
	if e != nil {
		log.Fatal(e)
	}
	g.Record(context.Background(), 1e-10, moni.Attributes{"case": "small"})
	g.Record(context.Background(), 1e200, moni.Attributes{"case": "large"})
	counter, e := c.Counter("precision.counter", moni.MetricOptions{})
	if e != nil {
		log.Fatal(e)
	}
	counter.Add(context.Background(), math.MaxInt64, moni.Attributes{"case": "int64"})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if e = c.Shutdown(ctx); e != nil {
		log.Fatal(e)
	}
	log.Print("Submitted tiny/large float64 and exact max int64")
}
