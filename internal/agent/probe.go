package agent

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	moni "github.com/lightmoni/lightmoni/sdk/go"
)

func validateProbes(probes []Probe) error {
	if len(probes) > 128 {
		return errors.New("at most 128 probes are allowed")
	}
	seen := map[string]bool{}
	for _, p := range probes {
		if strings.TrimSpace(p.ID) == "" || len(p.ID) > 128 || seen[p.ID] {
			return errors.New("probe IDs must be unique nonempty values <=128 bytes")
		}
		seen[p.ID] = true
		if p.IntervalSeconds < 1 || p.IntervalSeconds > 86400 || p.TimeoutMS < 1 || p.TimeoutMS > 120000 {
			return fmt.Errorf("probe %s has invalid interval or timeout", p.ID)
		}
		switch p.Kind {
		case "http":
			u, err := url.Parse(p.Target)
			if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
				return fmt.Errorf("probe %s requires an http(s) URL without embedded credentials", p.ID)
			}
		case "tcp":
			host, port, err := net.SplitHostPort(p.Target)
			number, portErr := strconv.Atoi(port)
			if err != nil || strings.TrimSpace(host) == "" || portErr != nil || number < 1 || number > 65535 {
				return fmt.Errorf("probe %s requires host:port", p.ID)
			}
		default:
			return fmt.Errorf("probe %s kind must be http or tcp", p.ID)
		}
		for _, status := range p.ExpectedStatus {
			if status < 100 || status > 599 {
				return fmt.Errorf("probe %s has invalid expected status", p.ID)
			}
		}
	}
	return nil
}

type ProbeResult struct {
	Success  bool
	Duration time.Duration
	Reason   string
	Status   int
}

func CheckProbe(ctx context.Context, p Probe) ProbeResult {
	started := time.Now()
	ctx, cancel := context.WithTimeout(ctx, time.Duration(p.TimeoutMS)*time.Millisecond)
	defer cancel()
	r := ProbeResult{Reason: "ok"}
	if p.Kind == "tcp" {
		connection, err := (&net.Dialer{}).DialContext(ctx, "tcp", p.Target)
		if err == nil {
			r.Success = true
			connection.Close()
		} else {
			r.Reason = probeReason(err)
		}
		r.Duration = time.Since(started)
		return r
	}
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}}, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("redirect limit")
		}
		return nil
	}}
	defer client.CloseIdleConnections()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.Target, nil)
	if err == nil {
		var response *http.Response
		response, err = client.Do(req)
		if err == nil {
			r.Status = response.StatusCode
			_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
			response.Body.Close()
			if len(p.ExpectedStatus) == 0 {
				r.Success = r.Status >= 200 && r.Status < 400
			} else {
				for _, status := range p.ExpectedStatus {
					if r.Status == status {
						r.Success = true
					}
				}
			}
			if !r.Success {
				r.Reason = "unexpected_status"
			}
		}
	}
	if err != nil {
		r.Reason = probeReason(err)
	}
	r.Duration = time.Since(started)
	return r
}

func probeReason(err error) string {
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "dns"
	}
	var n net.Error
	if errors.As(err, &n) && n.Timeout() {
		return "timeout"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if strings.Contains(strings.ToLower(err.Error()), "tls") || strings.Contains(strings.ToLower(err.Error()), "certificate") {
		return "tls"
	}
	return "connection"
}

func (a *Agent) probeLoop(ctx context.Context) {
	if !a.waitForTasks(ctx) {
		return
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	next := map[string]time.Time{}
	running := map[string]bool{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	defer wg.Wait()
	semaphore := make(chan struct{}, 16)
	table := ""
	taskVersion := ""
	var success *moni.Gauge
	var attempts, failures, skipped *moni.Counter
	var duration *moni.Histogram

	for {
		select {
		case <-ctx.Done():
			return
		case now := <-ticker.C:
			tasks := a.taskConfig()
			version := tasks.Revision + "\x00" + tasks.GroupID
			if version != taskVersion {
				clear(next)
				taskVersion = version
			}
			if table != tasks.ProbeTable {
				client := a.moni.WithTable(tasks.ProbeTable)
				success, _ = client.Gauge("probe.success", moni.MetricOptions{Unit: "1"})
				attempts, _ = client.Counter("probe.attempts", moni.MetricOptions{Unit: "1"})
				failures, _ = client.Counter("probe.failures", moni.MetricOptions{Unit: "1"})
				skipped, _ = client.Counter("probe.skipped", moni.MetricOptions{Unit: "1"})
				duration, _ = client.Histogram("probe.duration", moni.MetricOptions{Unit: "s", Boundaries: []float64{.01, .05, .1, .25, .5, 1, 2, 5, 10, 30}})
				table = tasks.ProbeTable
			}
			probes := append([]Probe(nil), tasks.Probes...)
			active := map[string]bool{}
			for _, p := range probes {
				active[p.ID] = true
			}
			for id := range next {
				if !active[id] {
					delete(next, id)
				}
			}
			for _, p := range probes {
				if now.Before(next[p.ID]) {
					continue
				}
				next[p.ID] = now.Add(time.Duration(p.IntervalSeconds) * time.Second)
				attrs := moni.Attributes{"probe_id": p.ID, "kind": p.Kind}
				mu.Lock()
				busy := running[p.ID]
				if !busy {
					running[p.ID] = true
				}
				mu.Unlock()
				if busy {
					if skipped != nil {
						skipped.Add(ctx, 1, attrs)
					}
					continue
				}
				select {
				case semaphore <- struct{}{}:
				default:
					mu.Lock()
					delete(running, p.ID)
					mu.Unlock()
					if skipped != nil {
						skipped.Add(ctx, 1, attrs)
					}
					continue
				}
				wg.Add(1)
				go func(p Probe, attrs moni.Attributes, success *moni.Gauge, attempts, failures, skipped *moni.Counter, duration *moni.Histogram) {
					defer wg.Done()
					defer func() { <-semaphore; mu.Lock(); delete(running, p.ID); mu.Unlock() }()
					result := CheckProbe(ctx, p)
					attrs["result"] = result.Reason
					if attempts != nil {
						attempts.Add(ctx, 1, attrs)
					}
					value := float64(0)
					if result.Success {
						value = 1
					} else if failures != nil {
						failures.Add(ctx, 1, attrs)
					}
					if success != nil {
						success.Record(ctx, value, moni.Attributes{"probe_id": p.ID, "kind": p.Kind})
					}
					if duration != nil {
						duration.Record(ctx, result.Duration.Seconds(), attrs)
					}
				}(p, attrs, success, attempts, failures, skipped, duration)
			}
		}
	}
}
