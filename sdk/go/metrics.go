package moni

import (
	"context"
	"errors"
	"math"
	"sort"
	"time"

	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	metricpb "go.opentelemetry.io/proto/otlp/metrics/v1"
	"google.golang.org/protobuf/proto"
)

type MetricOptions struct {
	Unit, Description string
	Boundaries        []float64
}
type measurement struct {
	attrs    []*commonpb.KeyValue
	integer  int64
	value    float64
	count    uint64
	buckets  []uint64
	observed time.Time
	min, max float64
}
type instrument struct {
	client                               *Client
	table, name, kind, unit, description string
	bounds                               []float64
	series                               map[string]*measurement
	start                                time.Time
}
type Counter struct{ m *instrument }
type Gauge struct{ m *instrument }
type Histogram struct{ m *instrument }

func (c *Client) Meter() *Client { return c }
func (c *Client) Counter(name string, options MetricOptions) (*Counter, error) {
	m, e := c.instrument(name, "counter", options)
	return &Counter{m: m}, e
}
func (c *Client) Gauge(name string, options MetricOptions) (*Gauge, error) {
	m, e := c.instrument(name, "gauge", options)
	return &Gauge{m: m}, e
}
func (c *Client) Histogram(name string, options MetricOptions) (*Histogram, error) {
	m, e := c.instrument(name, "histogram", options)
	return &Histogram{m: m}, e
}

func (c *Client) instrument(name, kind string, opt MetricOptions) (*instrument, error) {
	if c.table == "" || name == "" || len(name) > 255 || len(opt.Unit) > 64 || len(opt.Description) > 1024 {
		return nil, errors.New("invalid metric identity")
	}
	bounds := append([]float64(nil), opt.Boundaries...)
	if kind == "histogram" && len(bounds) == 0 {
		bounds = []float64{5, 10, 25, 50, 100, 250, 500, 1000}
	}
	if len(bounds) > 128 {
		return nil, errors.New("at most 128 histogram boundaries are supported")
	}
	for i, b := range bounds {
		if math.IsNaN(b) || math.IsInf(b, 0) || (i > 0 && bounds[i-1] >= b) {
			return nil, errors.New("histogram boundaries must be finite and strictly increasing")
		}
	}
	s := c.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return nil, errors.New("SDK is closing")
	}
	key := c.table + "\x00" + name
	if old := s.metrics[key]; old != nil {
		if old.kind != kind || old.unit != opt.Unit || len(old.bounds) != len(bounds) {
			return nil, errors.New("metric name already registered with conflicting type/unit/boundaries")
		}
		for i, b := range bounds {
			if old.bounds[i] != b {
				return nil, errors.New("conflicting histogram boundaries")
			}
		}
		return old, nil
	}
	if len(s.metrics) >= s.cfg.MaxInstruments {
		return nil, errors.New("instrument limit exceeded")
	}
	m := &instrument{client: c, table: c.table, name: name, kind: kind, unit: opt.Unit, description: opt.Description, bounds: bounds, series: map[string]*measurement{}, start: time.Now()}
	s.metrics[key] = m
	return m, nil
}

func (c *Counter) Add(_ context.Context, delta int64, attrs Attributes) {
	if c == nil || c.m == nil {
		return
	}
	if delta < 0 {
		c.m.client.s.invalid("counter increment must be nonnegative")
		return
	}
	c.m.record(float64(delta), delta, attrs)
}
func (g *Gauge) Record(_ context.Context, value float64, attrs Attributes) {
	if g == nil || g.m == nil {
		return
	}
	g.m.record(value, 0, attrs)
}
func (h *Histogram) Record(_ context.Context, value float64, attrs Attributes) {
	if h == nil || h.m == nil {
		return
	}
	h.m.record(value, 0, attrs)
}

func (m *instrument) record(value float64, integer int64, attrs Attributes) {
	s := m.client.s
	if math.IsNaN(value) || math.IsInf(value, 0) {
		s.invalid("metric value must be finite")
		return
	}
	encoded, key, err := encodeAttributes(attrs, s.cfg)
	if err != nil {
		s.invalid(err.Error())
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		s.stats.InvalidRecords++
		s.stats.LastError = "record after SDK shutdown"
		return
	}
	point := m.series[key]
	if s.reportingDisabled {
		s.stats.DisabledRecords++
		return
	}
	if point == nil && len(m.series) >= s.cfg.CardinalityLimit {
		key = "\x00overflow"
		encoded = []*commonpb.KeyValue{{Key: "otel.metric.overflow", Value: &commonpb.AnyValue{Value: &commonpb.AnyValue_BoolValue{BoolValue: true}}}}
		point = m.series[key]
		s.stats.OverflowRecords++
	}
	if point == nil {
		cost := len(key) + 128 + 8*(len(m.bounds)+1)
		if s.bufferBytes+cost > s.cfg.BufferBytes {
			s.stats.DroppedRecords++
			s.failure = errors.New("SDK aggregate buffer capacity exceeded; telemetry lost")
			s.lastFailure = s.sequence
			s.stats.LastError = s.failure.Error()
			return
		}
		point = &measurement{attrs: encoded, buckets: make([]uint64, len(m.bounds)+1), min: value, max: value}
		m.series[key] = point
		s.bufferBytes += cost
	}
	switch m.kind {
	case "counter":
		if integer > math.MaxInt64-point.integer {
			s.stats.InvalidRecords++
			s.stats.LastError = "counter overflow"
			return
		}
		point.integer += integer
	case "gauge":
		point.value = value
	case "histogram":
		if math.IsInf(point.value+value, 0) || point.count == math.MaxUint64 {
			s.stats.InvalidRecords++
			s.stats.LastError = "histogram overflow"
			return
		}
		point.value += value
		point.count++
		i := sort.SearchFloat64s(m.bounds, value)
		point.buckets[i]++
		if value < point.min {
			point.min = value
		}
		if value > point.max {
			point.max = value
		}
	}
	point.observed = time.Now()
}

func (m *instrument) collect(now time.Time) []*metricpb.Metric {
	keys := make([]string, 0, len(m.series))
	for k := range m.series {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	end := now
	if end.Before(m.start) {
		end = m.start
	}
	result := make([]*metricpb.Metric, 0, len(keys))
	for _, k := range keys {
		p := m.series[k]
		metric := &metricpb.Metric{Name: m.name, Unit: m.unit, Description: m.description}
		switch m.kind {
		case "counter":
			metric.Data = &metricpb.Metric_Sum{Sum: &metricpb.Sum{AggregationTemporality: metricpb.AggregationTemporality_AGGREGATION_TEMPORALITY_DELTA, IsMonotonic: true, DataPoints: []*metricpb.NumberDataPoint{{Attributes: p.attrs, StartTimeUnixNano: uint64(m.start.UnixNano()), TimeUnixNano: uint64(end.UnixNano()), Value: &metricpb.NumberDataPoint_AsInt{AsInt: p.integer}}}}}
		case "gauge":
			metric.Data = &metricpb.Metric_Gauge{Gauge: &metricpb.Gauge{DataPoints: []*metricpb.NumberDataPoint{{Attributes: p.attrs, TimeUnixNano: uint64(p.observed.UnixNano()), Value: &metricpb.NumberDataPoint_AsDouble{AsDouble: p.value}}}}}
		case "histogram":
			sum, min, max := p.value, p.min, p.max
			metric.Data = &metricpb.Metric_Histogram{Histogram: &metricpb.Histogram{AggregationTemporality: metricpb.AggregationTemporality_AGGREGATION_TEMPORALITY_DELTA, DataPoints: []*metricpb.HistogramDataPoint{{Attributes: p.attrs, StartTimeUnixNano: uint64(m.start.UnixNano()), TimeUnixNano: uint64(end.UnixNano()), Count: p.count, Sum: &sum, Min: &min, Max: &max, ExplicitBounds: m.bounds, BucketCounts: p.buckets}}}}
		}
		result = append(result, metric)
	}
	m.series = map[string]*measurement{}
	m.start = end
	return result
}

func mergeMetrics(metrics []*metricpb.Metric) []*metricpb.Metric {
	result := make([]*metricpb.Metric, 0, len(metrics))
	byName := map[string]*metricpb.Metric{}
	for _, metric := range metrics {
		current := byName[metric.Name]
		if current == nil {
			current = proto.Clone(metric).(*metricpb.Metric)
			byName[metric.Name] = current
			result = append(result, current)
			continue
		}
		if sum := current.GetSum(); sum != nil {
			sum.DataPoints = append(sum.DataPoints, metric.GetSum().DataPoints...)
		}
		if gauge := current.GetGauge(); gauge != nil {
			gauge.DataPoints = append(gauge.DataPoints, metric.GetGauge().DataPoints...)
		}
		if hist := current.GetHistogram(); hist != nil {
			hist.DataPoints = append(hist.DataPoints, metric.GetHistogram().DataPoints...)
		}
	}
	return result
}
