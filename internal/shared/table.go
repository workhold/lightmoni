package shared

import (
	"regexp"
	"strings"
)

var logicalTableName = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)

func ValidLogicalTable(name string) bool {
	return logicalTableName.MatchString(name) && !strings.HasPrefix(name, "log_") && !strings.HasPrefix(name, "metric_") && !strings.HasPrefix(name, "trace_")
}
