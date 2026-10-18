package moni

import (
	commonpb "go.opentelemetry.io/proto/otlp/common/v1"
	metricpb "go.opentelemetry.io/proto/otlp/metrics/v1"
	"math"
	"regexp"
	"time"
)

type observation struct {
	table, name               string
	attrs                     []*commonpb.KeyValue
	start                     time.Time
	scale                     int32
	positive, negative        map[int32]uint64
	zero, count, summaryCount uint64
	sum, min, max, summarySum float64
	bytes                     int
}

var dimensionSlot = regexp.MustCompile(`^key([1-9]|1[0-6])$`)

// Record observes a total value for count samples. Use count=1 for individual observations.
// A larger count retains sum/count without inventing the individual distribution.
func (c *Client) Record(table, metricName string, dimensions Attributes, value float64, count uint64) {
	s := c.s
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || s.closed {
		s.recordInvalid("record after shutdown")
		return
	}
	if s.reportingDisabled {
		s.stats.DisabledRecords++
		return
	}
	if s.cfg.Env == "" || !validTable(table) || systemSamplingTable(table) || table == "lightmoni" || metricName == "" || len(metricName) > 255 || math.IsNaN(value) || math.IsInf(value, 0) || count == 0 {
		s.recordInvalid("record requires env, business table, metric name, finite value and positive count")
		return
	}
	normalized := Attributes{}
	for key, val := range dimensions {
		v, ok := val.(string)
		if !dimensionSlot.MatchString(key) || !ok {
			s.recordInvalid("dimensions must be key1..key16 strings")
			return
		}
		if v != "" {
			normalized[key] = v
		}
	}
	attrs, key, err := encodeAttributes(normalized, s.cfg)
	if err != nil {
		s.recordInvalid(err.Error())
		return
	}
	key = table + "\x00" + metricName + "\x00" + key
	o := s.observations[key]
	if o == nil {
		if len(s.observations) >= s.cfg.CardinalityLimit {
			s.stats.OverflowRecords++
			return
		}
		cost := len(key) + 256
		if s.bufferBytes+cost > s.cfg.BufferBytes {
			s.stats.DroppedRecords++
			s.stats.LastError = "SDK aggregate buffer capacity exceeded"
			return
		}
		o = &observation{table: table, name: metricName, attrs: attrs, start: time.Now(), scale: 8, positive: map[int32]uint64{}, negative: map[int32]uint64{}, min: math.Inf(1), max: math.Inf(-1)}
		s.observations[key] = o
		s.bufferBytes += cost
	}
	if count > 1 {
		if math.MaxUint64-o.summaryCount < count || math.IsInf(o.summarySum+value, 0) {
			s.recordInvalid("summary overflow")
			return
		}
		o.summaryCount += count
		o.summarySum += value
		return
	}
	if o.count == math.MaxUint64 || math.IsInf(o.sum+value, 0) {
		s.recordInvalid("distribution overflow")
		return
	}
	if value != 0 {
		index := int32(math.Ceil(math.Log2(math.Abs(value))*math.Exp2(float64(o.scale)))) - 1
		for {
			side := o.positive
			if value < 0 {
				side = o.negative
			}
			low, high := index, index
			for k := range side {
				if k < low {
					low = k
				}
				if k > high {
					high = k
				}
			}
			if high-low < 1024 {
				break
			}
			o.positive = downscale(o.positive)
			o.negative = downscale(o.negative)
			o.scale--
			index = floorHalf(index)
		}
		side := o.positive
		if value < 0 {
			side = o.negative
		}
		extra := 0
		if _, ok := side[index]; !ok {
			extra = 1
		}
		size := (len(o.positive) + len(o.negative) + extra) * 32
		if s.bufferBytes+size-o.bytes > s.cfg.BufferBytes {
			s.stats.DroppedRecords++
			s.stats.LastError = "SDK distribution buffer capacity exceeded"
			return
		}
		side[index]++
		s.bufferBytes += size - o.bytes
		o.bytes = size
	} else {
		o.zero++
	}
	o.count++
	o.sum += value
	o.min = math.Min(o.min, value)
	o.max = math.Max(o.max, value)
}
func floorHalf(v int32) int32 {
	if v < 0 {
		return (v - 1) / 2
	}
	return v / 2
}
func downscale(side map[int32]uint64) map[int32]uint64 {
	next := map[int32]uint64{}
	for i, n := range side {
		next[floorHalf(i)] += n
	}
	return next
}
func expBuckets(side map[int32]uint64) *metricpb.ExponentialHistogramDataPoint_Buckets {
	if len(side) == 0 {
		return &metricpb.ExponentialHistogramDataPoint_Buckets{}
	}
	first := true
	var low, high int32
	for i := range side {
		if first || i < low {
			low = i
		}
		if first || i > high {
			high = i
		}
		first = false
	}
	counts := make([]uint64, high-low+1)
	for i, n := range side {
		counts[i-low] = n
	}
	return &metricpb.ExponentialHistogramDataPoint_Buckets{Offset: low, BucketCounts: counts}
}
func (o *observation) collect(now time.Time) []*metricpb.Metric {
	end := now
	if end.Before(o.start) {
		end = o.start
	}
	out := []*metricpb.Metric{}
	if o.count > 0 {
		sum, min, max := o.sum, o.min, o.max
		out = append(out, &metricpb.Metric{Name: o.name, Data: &metricpb.Metric_ExponentialHistogram{ExponentialHistogram: &metricpb.ExponentialHistogram{AggregationTemporality: metricpb.AggregationTemporality_AGGREGATION_TEMPORALITY_DELTA, DataPoints: []*metricpb.ExponentialHistogramDataPoint{{Attributes: o.attrs, StartTimeUnixNano: uint64(o.start.UnixNano()), TimeUnixNano: uint64(end.UnixNano()), Count: o.count, Sum: &sum, Min: &min, Max: &max, Scale: o.scale, ZeroCount: o.zero, Positive: expBuckets(o.positive), Negative: expBuckets(o.negative)}}}}})
	}
	if o.summaryCount > 0 {
		out = append(out, &metricpb.Metric{Name: o.name, Data: &metricpb.Metric_Summary{Summary: &metricpb.Summary{DataPoints: []*metricpb.SummaryDataPoint{{Attributes: o.attrs, StartTimeUnixNano: uint64(o.start.UnixNano()), TimeUnixNano: uint64(end.UnixNano()), Count: o.summaryCount, Sum: o.summarySum}}}}})
	}
	return out
}

func (s *state) recordInvalid(message string) { s.stats.InvalidRecords++; s.stats.LastError = message }
