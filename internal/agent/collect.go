package agent

import (
	"context"
	"fmt"
	"math"
	"path/filepath"
	"strings"
	"time"

	moni "github.com/lightmoni/lightmoni/sdk/go"
	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
)

type collector struct {
	client      *moni.Client
	gauges      map[string]*moni.Gauge
	counters    map[string]*moni.Counter
	previous    map[string]uint64
	cpuBaseline bool
}

func newCollector(c *moni.Client) *collector {
	return &collector{client: c, gauges: map[string]*moni.Gauge{}, counters: map[string]*moni.Counter{}, previous: map[string]uint64{}}
}
func (c *collector) gauge(ctx context.Context, name, unit string, value float64, attrs moni.Attributes) {
	g := c.gauges[name]
	if g == nil {
		var err error
		g, err = c.client.Gauge(name, moni.MetricOptions{Unit: unit})
		if err != nil {
			return
		}
		c.gauges[name] = g
	}
	g.Record(ctx, value, attrs)
}
func (c *collector) delta(ctx context.Context, name, unit, source string, current uint64, attrs moni.Attributes) {
	previous, exists := c.previous[source]
	c.previous[source] = current
	if !exists || current < previous {
		return
	}
	d := current - previous
	if d > math.MaxInt64 {
		return
	}
	counter := c.counters[name]
	if counter == nil {
		var err error
		counter, err = c.client.Counter(name, moni.MetricOptions{Unit: unit})
		if err != nil {
			return
		}
		c.counters[name] = counter
	}
	counter.Add(ctx, int64(d), attrs)
}

func (a *Agent) collectLoop(ctx context.Context) {
	if !a.waitForTasks(ctx) {
		return
	}
	var c *collector
	lastSettings := ""
	for {
		tasks := a.taskConfig()
		settings := tasks.HostTable + strings.Join(tasks.HostCollectors, ",") + strings.Join(tasks.ProcessNames, ",") + fmt.Sprint(*tasks.HostEnabled)
		if c == nil || settings != lastSettings {
			c = newCollector(a.moni.WithTable(tasks.HostTable))
			lastSettings = settings
		}
		a.collect(ctx, c, tasks)
		a.mu.RLock()
		interval := a.collectInterval
		a.mu.RUnlock()
		timer := time.NewTimer(time.Duration(interval) * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-a.tasksChanged:
			timer.Stop()
		case <-timer.C:
		}
	}
}

// CollectOnce is useful for smoke checks and performs real host reads. Repeated
// sampling/Delta baselines are maintained by the long-lived collectLoop.
func (a *Agent) CollectOnce(ctx context.Context) error {
	tasks := a.taskConfig()
	a.collect(ctx, newCollector(a.moni.WithTable(tasks.HostTable)), tasks)
	return a.moni.Flush(ctx)
}

func (a *Agent) collect(parent context.Context, c *collector, tasks RemoteConfig) {
	ctx, cancel := context.WithTimeout(parent, 5*time.Second)
	defer cancel()
	if !*tasks.HostEnabled {
		return
	}
	selected := map[string]bool{}
	for _, name := range tasks.HostCollectors {
		selected[name] = true
	}
	attrs := moni.Attributes{"host_id": a.identity.HostID}
	if selected["cpu"] {
		percent, err := cpu.PercentWithContext(ctx, 0, false)
		if err != nil {
			a.collectorStatus("cpu", err.Error())
		} else {
			if c.cpuBaseline && len(percent) > 0 {
				c.gauge(ctx, "host.cpu.utilization", "1", percent[0]/100, attrs)
			}
			c.cpuBaseline = true
			a.collectorStatus("cpu", "ok")
		}
	}
	if selected["memory"] {
		if m, e := mem.VirtualMemoryWithContext(ctx); e == nil {
			c.gauge(ctx, "host.memory.used", "By", float64(m.Used), attrs)
			c.gauge(ctx, "host.memory.available", "By", float64(m.Available), attrs)
			c.gauge(ctx, "host.memory.total", "By", float64(m.Total), attrs)
			a.collectorStatus("memory", "ok")
		} else {
			a.collectorStatus("memory", e.Error())
		}
		if swap, e := mem.SwapMemoryWithContext(ctx); e == nil {
			c.gauge(ctx, "host.swap.used", "By", float64(swap.Used), attrs)
			c.gauge(ctx, "host.swap.total", "By", float64(swap.Total), attrs)
		}
	}
	if selected["system"] {
		if uptime, e := host.UptimeWithContext(ctx); e == nil {
			c.gauge(ctx, "host.uptime", "s", float64(uptime), attrs)
		}
		if avg, e := load.AvgWithContext(ctx); e == nil {
			c.gauge(ctx, "host.load.average", "1", avg.Load1, moni.Attributes{"period": "1m"})
			c.gauge(ctx, "host.load.average", "1", avg.Load5, moni.Attributes{"period": "5m"})
			c.gauge(ctx, "host.load.average", "1", avg.Load15, moni.Attributes{"period": "15m"})
		}
	}
	if selected["filesystem"] {
		partitions, e := disk.PartitionsWithContext(ctx, false)
		if e != nil {
			a.collectorStatus("filesystem", e.Error())
		} else {
			count := 0
			lastError := ""
			for _, p := range partitions {
				if count >= 32 {
					break
				}
				if strings.HasPrefix(p.Mountpoint, "/proc") || strings.HasPrefix(p.Mountpoint, "/sys") || strings.HasPrefix(p.Mountpoint, "/dev/") {
					continue
				}
				u, e := disk.UsageWithContext(ctx, p.Mountpoint)
				if e != nil {
					lastError = e.Error()
					continue
				}
				count++
				attr := moni.Attributes{"mountpoint": p.Mountpoint, "filesystem": p.Fstype}
				c.gauge(ctx, "host.filesystem.used", "By", float64(u.Used), attr)
				c.gauge(ctx, "host.filesystem.total", "By", float64(u.Total), attr)
			}
			if lastError != "" {
				a.collectorStatus("filesystem", lastError)
			} else {
				a.collectorStatus("filesystem", "ok")
			}
		}
	}
	if selected["disk"] {
		if io, e := disk.IOCountersWithContext(ctx); e == nil {
			count := 0
			for device, v := range io {
				if count >= 32 {
					break
				}
				count++
				c.delta(ctx, "host.disk.io", "By", "diskread:"+device, v.ReadBytes, moni.Attributes{"device": device, "direction": "read"})
				c.delta(ctx, "host.disk.io", "By", "diskwrite:"+device, v.WriteBytes, moni.Attributes{"device": device, "direction": "write"})
			}
			a.collectorStatus("disk", "ok")
		} else {
			a.collectorStatus("disk", e.Error())
		}
	}
	if selected["network"] {
		if io, e := net.IOCountersWithContext(ctx, true); e == nil {
			for i, v := range io {
				if i >= 32 {
					break
				}
				c.delta(ctx, "host.network.io", "By", "netrecv:"+v.Name, v.BytesRecv, moni.Attributes{"interface": v.Name, "direction": "receive"})
				c.delta(ctx, "host.network.io", "By", "netsend:"+v.Name, v.BytesSent, moni.Attributes{"interface": v.Name, "direction": "transmit"})
			}
			a.collectorStatus("network", "ok")
		} else {
			a.collectorStatus("network", e.Error())
		}
	}
	if selected["process"] {
		a.collectProcesses(ctx, c, tasks.ProcessNames)
	}
	if stats, e := a.queue.Stats(ctx); e == nil {
		self := c.client
		for name, value := range map[string]float64{"agent.queue.bytes": float64(stats.Bytes), "agent.queue.batches": float64(stats.Batches), "agent.queue.oldest_age": float64(stats.OldestAgeSeconds), "agent.queue.quarantine": float64(stats.Quarantine)} {
			unit := "1"
			if name == "agent.queue.bytes" {
				unit = "By"
			}
			if name == "agent.queue.oldest_age" {
				unit = "s"
			}
			g, e := self.Gauge(name, moni.MetricOptions{Unit: unit})
			if e == nil {
				g.Record(ctx, value, nil)
			}
		}
	}
}

func (a *Agent) collectProcesses(ctx context.Context, c *collector, processNames []string) {
	if len(processNames) == 0 {
		return
	}
	processes, err := process.ProcessesWithContext(ctx)
	if err != nil {
		a.collectorStatus("process", err.Error())
		return
	}
	matched := map[string]int{}
	failures := 0
	unknownNames := 0
	activeProcesses := map[string]bool{}
	for _, p := range processes {
		name, e := p.NameWithContext(ctx)
		if e != nil {
			unknownNames++
			continue
		}
		var pattern string
		for _, configured := range processNames {
			ok, _ := filepath.Match(configured, name)
			if ok {
				pattern = configured
				break
			}
		}
		if pattern == "" || matched[pattern] >= 8 {
			continue
		}
		matched[pattern]++
		start, e := p.CreateTimeWithContext(ctx)
		if e != nil {
			failures++
			continue
		}
		identity := fmt.Sprintf("%d:%d", p.Pid, start)
		activeProcesses["processcpu:"+identity] = true
		attrs := moni.Attributes{"process_name": name, "process_id": identity, "matcher": pattern}
		c.gauge(ctx, "process.running", "1", 1, attrs)
		if v, e := p.MemoryInfoWithContext(ctx); e == nil {
			c.gauge(ctx, "process.memory.rss", "By", float64(v.RSS), attrs)
		} else {
			failures++
		}
		if v, e := p.NumThreadsWithContext(ctx); e == nil {
			c.gauge(ctx, "process.threads", "1", float64(v), attrs)
		}
		if v, e := p.NumFDsWithContext(ctx); e == nil {
			c.gauge(ctx, "process.file_descriptors", "1", float64(v), attrs)
		}
		if v, e := p.TimesWithContext(ctx); e == nil {
			seconds := uint64((v.User + v.System) * 1e9)
			c.delta(ctx, "process.cpu.time", "ns", "processcpu:"+identity, seconds, attrs)
		} else {
			failures++
		}
	}
	for key := range c.previous {
		if strings.HasPrefix(key, "processcpu:") && !activeProcesses[key] {
			delete(c.previous, key)
		}
	}
	for _, pattern := range processNames {
		if matched[pattern] == 0 && unknownNames > 0 {
			continue
		}
		running := float64(0)
		if matched[pattern] > 0 {
			running = 1
		}
		c.gauge(ctx, "process.matcher.running", "1", running, moni.Attributes{"matcher": pattern})
	}
	if failures > 0 || unknownNames > 0 {
		a.collectorStatus("process", fmt.Sprintf("partial: %d unavailable measurements, %d unreadable process names", failures, unknownNames))
	} else {
		a.collectorStatus("process", "ok")
	}
}
