package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"net/http"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	moni "github.com/lightmoni/lightmoni/sdk/go"
	"os"
)

var Version = "0.1.0"

type Agent struct {
	cfg             Config
	identity        Identity
	queue           *Queue
	http            *http.Client
	mu              sync.RWMutex
	sdkConfigMu     sync.Mutex
	lastError       string
	lastSuccess     time.Time
	collectors      map[string]string
	revision        string
	collectInterval int
	probes          []Probe
	tasks           RemoteConfig
	tasksChanged    chan struct{}
	tasksReady      chan struct{}
	tasksReadyOnce  sync.Once
	hostname        string
	moni            *moni.Client
	runtimeEvents   []RuntimeEvent
	runtimeSequence uint64
	runtimeInstance string
}

func New(cfg Config) (*Agent, error) {
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	id, err := loadIdentity(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	queue, err := OpenQueue(cfg)
	if err != nil {
		return nil, err
	}
	hostname, _ := os.Hostname()
	a := &Agent{cfg: cfg, identity: id, queue: queue, http: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, collectors: map[string]string{}, collectInterval: cfg.CollectIntervalSeconds, probes: cfg.Probes, hostname: hostname}
	a.tasks = NormalizeRemoteConfig(RemoteConfig{CollectIntervalSeconds: cfg.CollectIntervalSeconds, Probes: cfg.Probes, ProcessNames: cfg.ProcessNames})
	a.tasksChanged = make(chan struct{}, 1)
	a.tasksReady = make(chan struct{})
	a.runtimeInstance = strconv.FormatInt(time.Now().UnixNano(), 10)
	a.runtimeEvent("INFO", "started", "Agent started")
	a.moni, err = moni.New(moni.Config{Service: "lightmoni-agent", Table: "host", InstanceID: id.AgentID, Exporter: a, ConfigEndpoint: cfg.Endpoint, ConfigKey: cfg.Key, Interval: time.Duration(cfg.CollectIntervalSeconds) * time.Second, MaxBatchBytes: int(cfg.MaxBatchBytes / 2), DisableSelfTelemetry: true})
	if err != nil {
		queue.Close()
		return nil, err
	}
	return a, nil
}

func (a *Agent) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := a.moni.Shutdown(ctx)
	return errors.Join(err, a.queue.Close())
}
func (a *Agent) ID() string { return a.identity.AgentID }
func (a *Agent) setError(message string) {
	a.mu.Lock()
	changed := a.lastError != message
	a.lastError = message
	a.mu.Unlock()
	if changed {
		a.runtimeEvent("WARN", "execution_failed", a.safeRuntimeMessage(message))
	}
	slog.Warn("agent", "error", message)
}
func (a *Agent) collectorStatus(name, status string) {
	a.mu.Lock()
	previous := a.collectors[name]
	a.collectors[name] = status
	a.mu.Unlock()
	if previous != status && status != "ok" && status != "disabled" {
		a.runtimeEvent("WARN", "collector_failed", name+": "+a.safeRuntimeMessage(status))
	}
}
func (a *Agent) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/sdk-config", a.sdkConfigHandler)
	for _, s := range []string{"logs", "metrics", "traces"} {
		mux.HandleFunc("POST /v1/"+s, a.receiver(s))
	}
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		_, err := a.queue.Stats(r.Context())
		status := 200
		if err != nil {
			status = 503
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(http.StatusText(status)))
	})
	mux.HandleFunc("GET /status", func(w http.ResponseWriter, r *http.Request) {
		if !a.authorizeLocal(r) {
			http.Error(w, "local token required", 401)
			return
		}
		status, err := a.Status(r.Context())
		if err != nil {
			http.Error(w, err.Error(), 503)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(status)
	})
	return mux
}

func (a *Agent) authorizeLocal(r *http.Request) bool {
	return a.cfg.LocalToken == "" || r.Header.Get("Authorization") == "Bearer "+a.cfg.LocalToken
}

func (a *Agent) Run(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	for _, run := range []func(context.Context){a.forwardLoop, a.controlLoop, a.collectLoop, a.probeLoop, a.fileLogLoop} {
		wg.Add(1)
		go func(fn func(context.Context)) { defer wg.Done(); fn(ctx) }(run)
	}
	server := &http.Server{Addr: a.cfg.Listen, Handler: a.Handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 20 * time.Second, WriteTimeout: 20 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	errCh := make(chan error, 1)
	go func() { errCh <- server.ListenAndServe() }()
	var err error
	select {
	case <-ctx.Done():
	case err = <-errCh:
	}
	cancel()
	shutdownCtx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	_ = server.Shutdown(shutdownCtx)
	wg.Wait()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func (a *Agent) Status(ctx context.Context) (map[string]any, error) {
	s, err := a.queue.Stats(ctx)
	if err != nil {
		return nil, err
	}
	a.mu.RLock()
	defer a.mu.RUnlock()
	collectors := map[string]string{}
	for k, v := range a.collectors {
		collectors[k] = v
	}
	return map[string]any{"agent_id": a.identity.AgentID, "group_id": a.cfg.GroupID, "host_id": a.identity.HostID, "hostname": a.hostname, "version": Version, "platform": runtime.GOOS, "arch": runtime.GOARCH, "config_revision": a.revision, "queue_bytes": s.Bytes, "queue_batches": s.Batches, "quarantine_batches": s.Quarantine, "receipts": s.Receipts, "oldest_age_seconds": s.OldestAgeSeconds, "last_error": a.lastError, "last_success_at": a.lastSuccess, "collectors_status": collectors, "sdk": a.moni.Stats(), "runtime_events": append([]RuntimeEvent{}, a.runtimeEvents...), "control_interval_seconds": a.cfg.ControlIntervalSeconds}, nil
}

type sendResult struct {
	permanent  bool
	credential bool
	retryAfter time.Duration
	message    string
}

func (a *Agent) send(ctx context.Context, b Queued) sendResult {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(a.cfg.Endpoint, "/")+"/v1/"+b.Signal, strings.NewReader(string(b.Payload)))
	if err != nil {
		return sendResult{permanent: true, message: err.Error()}
	}
	req.Header.Set("Content-Type", b.ContentType)
	req.Header.Set("X-Lightmoni-Table", b.Table)
	req.Header.Set("X-Lightmoni-Batch-ID", b.ID)
	req.Header.Set("X-Lightmoni-Batch-Created-At", b.CreatedAt.Format(time.RFC3339Nano))
	req.Header.Set("Authorization", "Bearer "+a.cfg.Key)
	resp, err := a.http.Do(req)
	if err != nil {
		return sendResult{message: "upstream network error"}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if err != nil {
		return sendResult{message: "upstream response unreadable"}
	}
	if resp.StatusCode == 200 {
		// Full-success responses may encode an empty message. A partial success
		// response is not a whole-batch durable acknowledgement for this pipeline.
		msg := emptyResponse(b.Signal)
		if strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
			err = jsonProto(body, msg)
		} else {
			err = binaryProto(body, msg)
		}
		if err != nil {
			return sendResult{message: "upstream invalid OTLP acknowledgment"}
		}
		if hasPartial(msg) {
			return sendResult{permanent: true, message: "upstream partial success requires operator review"}
		}
		return sendResult{}
	}
	result := sendResult{message: fmt.Sprintf("upstream HTTP %d", resp.StatusCode)}
	switch resp.StatusCode {
	case 401, 403:
		result.credential = true
		result.retryAfter = 30 * time.Second
	case 429, 502, 503, 504:
		result.retryAfter = parseRetryAfter(resp.Header.Get("Retry-After"))
	default:
		result.permanent = true
	}
	return result
}

func parseRetryAfter(s string) time.Duration {
	if seconds, err := strconv.Atoi(s); err == nil && seconds >= 0 {
		return time.Duration(seconds) * time.Second
	}
	if t, err := http.ParseTime(s); err == nil {
		if d := time.Until(t); d > 0 {
			return d
		}
	}
	return 0
}

func (a *Agent) forwardLoop(ctx context.Context) {
	tick := time.NewTicker(250 * time.Millisecond)
	defer tick.Stop()
	for {
		if ctx.Err() != nil {
			return
		}
		b, ok, err := a.queue.Next(ctx)
		if err != nil {
			a.setError("queue read failed: " + err.Error())
		}
		if err != nil || !ok {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
			}
			continue
		}
		if time.Since(b.CreatedAt) > a.cfg.maxAge() {
			if err = a.queue.Quarantine(ctx, b.ID, "expired: maximum replay age exceeded"); err != nil {
				a.setError(err.Error())
			}
			continue
		}
		result := a.send(ctx, b)
		if ctx.Err() != nil {
			return
		}
		if result.message == "" {
			err = a.queue.Complete(ctx, b.ID)
			if err == nil {
				a.mu.Lock()
				a.lastSuccess = time.Now().UTC()
				a.lastError = ""
				a.mu.Unlock()
			}
		} else if result.permanent {
			err = a.queue.Quarantine(ctx, b.ID, result.message)
			a.setError(result.message)
		} else {
			delay := time.Second * time.Duration(1<<min(b.Attempts, 6))
			delay = delay/2 + time.Duration(rand.Int63n(int64(delay/2)+1))
			if result.retryAfter > delay {
				delay = result.retryAfter
			}
			err = a.queue.Retry(ctx, b.ID, result.message, time.Now().Add(delay))
			a.setError(result.message)
			// The Agent has one global credential/destination: back off the whole
			// sender rather than hammering a failed endpoint with every queued item.
			if err == nil {
				timer := time.NewTimer(delay)
				select {
				case <-ctx.Done():
					timer.Stop()
					return
				case <-timer.C:
				}
			}
		}
		if err != nil {
			a.setError("queue update failed: " + err.Error())
		}
	}
}
