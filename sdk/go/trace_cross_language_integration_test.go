package moni

import (
	"bufio"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTracePropagationGoNodeGo(t *testing.T) {
	if os.Getenv("LIGHTMONI_TRACE_TEST") != "1" {
		t.Skip("set LIGHTMONI_TRACE_TEST=1 after building sdk/typescript")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	root, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	upSink, downSink := &recorder{}, &recorder{}
	up, down := testClient(t, Config{Exporter: upSink}), testClient(t, Config{Exporter: downSink})
	downServer := httptest.NewServer(down.TraceHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		down.Logger(r.Context()).Log("info", "go downstream", nil)
		trace, _ := TraceContextFromContext(r.Context())
		_ = json.NewEncoder(w).Encode(trace)
	})))
	defer downServer.Close()
	script := `
import {createServer} from 'node:http';
import {createLightMoni,traceHandler} from './sdk/typescript/dist/src/index.js';
const batches=[];
const mon=createLightMoni({service:'node-hop',table:'http',selfTelemetry:false,intervalMs:60000,
  exporter:{async deliver(batch){batches.push({signal:batch.signal,data:JSON.parse(new TextDecoder().decode(batch.payload))});}}});
const handler=traceHandler(mon,'node HTTP',async(req,res)=>{
  mon.log('info','node before');
  const response=await mon.fetch(process.env.LIGHTMONI_DOWNSTREAM_URL);
  if(response.status!==200)throw new Error('downstream failed');
  const downstream=await response.json();
  mon.log('info','node after');
  res.end(JSON.stringify({node:mon.currentTrace(),downstream}));
},req=>({traceparent:req.headers.traceparent,tracestate:req.headers.tracestate}));
const server=createServer((req,res)=>{
  if(req.url==='/snapshot'){void mon.flush().then(()=>res.end(JSON.stringify(batches))).catch(()=>{res.statusCode=500;res.end();});return;}
  void handler(req,res).catch(()=>{res.statusCode=500;res.end();});
});
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port));
`
	cmd := exec.Command(node, "--input-type=module", "--eval", script)
	cmd.Dir = root
	cmd.Env = append(os.Environ(), "LIGHTMONI_DOWNSTREAM_URL="+downServer.URL)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	ready := make(chan string, 1)
	go func() {
		scanner := bufio.NewScanner(stdout)
		if scanner.Scan() {
			ready <- scanner.Text()
		} else {
			ready <- ""
		}
	}()
	var nodeURL string
	select {
	case nodeURL = <-ready:
	case <-time.After(10 * time.Second):
		t.Fatal("Node HTTP service did not start")
	}
	if !strings.HasPrefix(nodeURL, "http://127.0.0.1:") {
		t.Fatalf("invalid Node service URL: %q", nodeURL)
	}
	httpClient := &http.Client{Transport: TraceTransport{}, Timeout: 5 * time.Second}
	upServer := httptest.NewServer(up.TraceHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		up.Logger(r.Context()).Log("info", "go upstream", nil)
		request, _ := http.NewRequestWithContext(r.Context(), "GET", nodeURL, nil)
		response, err := httpClient.Do(request)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer response.Body.Close()
		w.WriteHeader(response.StatusCode)
		_, _ = io.Copy(w, response.Body)
	})))
	defer upServer.Close()
	request, _ := http.NewRequest("GET", upServer.URL, nil)
	request.Header.Set("traceparent", "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00")
	request.Header.Set("tracestate", "vendor=interop")
	response, err := httpClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var traces struct {
		Node       TraceContext
		Downstream TraceContext
	}
	if err = json.NewDecoder(response.Body).Decode(&traces); err != nil || response.StatusCode != 200 {
		t.Fatalf("cross-language request failed: %v status=%d", err, response.StatusCode)
	}
	if traces.Node.TraceID != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" || traces.Downstream.TraceID != traces.Node.TraceID || traces.Downstream.TraceState != "vendor=interop" || traces.Downstream.Flags != 0 {
		t.Fatalf("W3C context was lost across languages: %+v", traces)
	}
	flush(t, up)
	flush(t, down)
	upLogs, upSpans := traceRecords(t, upSink.snapshot())
	downLogs, downSpans := traceRecords(t, downSink.snapshot())
	snapshot, err := httpClient.Get(nodeURL + "/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	defer snapshot.Body.Close()
	var batches []struct {
		Signal string
		Data   struct {
			ResourceLogs []struct {
				ScopeLogs []struct {
					LogRecords []struct {
						TraceID string `json:"traceId"`
						SpanID  string `json:"spanId"`
					}
				} `json:"scopeLogs"`
			} `json:"resourceLogs"`
			ResourceSpans []struct {
				ScopeSpans []struct {
					Spans []struct {
						TraceID      string `json:"traceId"`
						SpanID       string `json:"spanId"`
						ParentSpanID string `json:"parentSpanId"`
					}
				} `json:"scopeSpans"`
			} `json:"resourceSpans"`
		}
	}
	if err = json.NewDecoder(snapshot.Body).Decode(&batches); err != nil {
		t.Fatal(err)
	}
	nodeLogs, nodeSpans := 0, 0
	for _, batch := range batches {
		for _, resource := range batch.Data.ResourceLogs {
			for _, scope := range resource.ScopeLogs {
				for _, log := range scope.LogRecords {
					nodeLogs++
					if log.TraceID != traces.Node.TraceID || log.SpanID != traces.Node.SpanID {
						t.Fatal("Node logs did not capture their current context")
					}
				}
			}
		}
		for _, resource := range batch.Data.ResourceSpans {
			for _, scope := range resource.ScopeSpans {
				for _, span := range scope.Spans {
					nodeSpans++
					if span.ParentSpanID != hex.EncodeToString(upLogs["go upstream"].SpanId) || span.SpanID != traces.Node.SpanID {
						t.Fatal("Go to Node span parent was lost")
					}
				}
			}
		}
	}
	if nodeLogs != 2 || nodeSpans != 1 || len(upSpans) != 1 || len(downSpans) != 1 {
		t.Fatalf("unexpected cross-language telemetry: node logs=%d spans=%d go=%d/%d", nodeLogs, nodeSpans, len(upSpans), len(downSpans))
	}
	child := downSpans[hex.EncodeToString(downLogs["go downstream"].SpanId)]
	if child == nil || hex.EncodeToString(child.ParentSpanId) != traces.Node.SpanID {
		t.Fatal("Node to Go span parent was lost")
	}
	if traces.Node.SpanID == traces.Downstream.SpanID {
		t.Fatal("services reused the same span ID")
	}
}
