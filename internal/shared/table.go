package shared

import (
	"regexp"
	"strings"
)

var logicalTableName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)

func ValidLogicalTable(name string) bool {
	return logicalTableName.MatchString(name) && !strings.HasPrefix(name, "log_") && !strings.HasPrefix(name, "metric_") && !strings.HasPrefix(name, "trace_")
}

func SystemLogicalTable(name string) bool {
	return name == "lightmoni_center" || name == "lightmoni_agent" || name == "lightmoni_sdk"
}
