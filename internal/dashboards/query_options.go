package dashboards

import (
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"strconv"
	"strings"
)

var queryDuration = regexp.MustCompile(`^([1-9][0-9]*)(ms|s|m|min|h|d)$`)

func validateQueryOptions(options map[string]any) error {
	for _, key := range []string{"query_interval", "query_min_interval"} {
		value, exists := options[key]
		if !exists {
			continue
		}
		text, ok := value.(string)
		if ok && (key == "query_interval" && text == "auto" || key == "query_min_interval" && text == "") {
			continue
		}
		match := queryDuration.FindStringSubmatch(strings.TrimSpace(text))
		if !ok || match == nil {
			return errors.New("聚合间隔须为正整数加单位，例如 30s、1min、5min 或 1h")
		}
		number, err := strconv.ParseInt(match[1], 10, 64)
		unit := map[string]int64{"ms": 1, "s": 1000, "m": 60000, "min": 60000, "h": 3600000, "d": 86400000}[match[2]]
		if err != nil || number > 31536000000/unit {
			return errors.New("聚合间隔不能超过 365d")
		}
	}
	if value, exists := options["query_max_points"]; exists {
		var number float64
		switch value := value.(type) {
		case json.Number:
			number, _ = value.Float64()
		case float64:
			number = value
		case int:
			number = float64(value)
		}
		if math.IsNaN(number) || number < 1 || number > 10000 || math.Trunc(number) != number {
			return errors.New("最大数据点须为 1–10000 的整数")
		}
	}
	return nil
}
