package output

import (
	"fmt"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

const defaultIndent = "  "

// FormatValue formats a Go/BSON value as a mongosh-style string.
func FormatValue(val interface{}, indent int) string {
	if val == nil {
		return "null"
	}

	prefix := strings.Repeat(defaultIndent, indent)
	innerPrefix := strings.Repeat(defaultIndent, indent+1)

	switch v := val.(type) {
	case bson.D:
		return formatDocument(v, indent)
	case bson.M:
		doc := bson.D{}
		for k, val := range v {
			doc = append(doc, bson.E{Key: k, Value: val})
		}
		return formatDocument(doc, indent)
	case bson.A:
		if len(v) == 0 {
			return "[ ]"
		}
		allSimple := true
		for _, item := range v {
			switch item.(type) {
			case bson.D, bson.M, bson.A:
				allSimple = false
			}
		}
		if allSimple && len(v) <= 5 {
			parts := make([]string, len(v))
			for i, item := range v {
				parts[i] = FormatValue(item, 0)
			}
			return "[ " + strings.Join(parts, ", ") + " ]"
		}
		var sb strings.Builder
		sb.WriteString("[\n")
		for i, item := range v {
			sb.WriteString(innerPrefix)
			sb.WriteString(FormatValue(item, indent+1))
			if i < len(v)-1 {
				sb.WriteString(",")
			}
			sb.WriteString("\n")
		}
		sb.WriteString(prefix)
		sb.WriteString("]")
		return sb.String()
	case bson.ObjectID:
		return fmt.Sprintf("ObjectId('%s')", v.Hex())
	case bson.DateTime:
		t := time.UnixMilli(int64(v))
		return fmt.Sprintf("ISODate('%s')", t.UTC().Format("2006-01-02T15:04:05.000Z"))
	case bson.Decimal128:
		return fmt.Sprintf("NumberDecimal('%s')", v.String())
	case bson.Timestamp:
		return fmt.Sprintf("Timestamp({ t: %d, i: %d })", v.T, v.I)
	case bson.Regex:
		return fmt.Sprintf("/%s/%s", v.Pattern, v.Options)
	case bson.Binary:
		return fmt.Sprintf("Binary.createFromBase64('%x', %d)", v.Data, v.Subtype)
	case string:
		return fmt.Sprintf("'%s'", escapeString(v))
	case bool:
		if v {
			return "true"
		}
		return "false"
	case int32:
		return fmt.Sprintf("%d", v)
	case int64:
		return fmt.Sprintf("Long('%d')", v)
	case float64:
		if v == float64(int64(v)) {
			return fmt.Sprintf("%g", v)
		}
		return fmt.Sprintf("%v", v)
	case int:
		return fmt.Sprintf("%d", v)
	case time.Time:
		return fmt.Sprintf("ISODate('%s')", v.UTC().Format("2006-01-02T15:04:05.000Z"))
	default:
		return fmt.Sprintf("%v", v)
	}
}

func formatDocument(doc bson.D, indent int) string {
	if len(doc) == 0 {
		return "{ }"
	}

	prefix := strings.Repeat(defaultIndent, indent)
	innerPrefix := strings.Repeat(defaultIndent, indent+1)

	// For small, simple documents, use single-line format
	if len(doc) <= 3 && isSimpleDoc(doc) {
		parts := make([]string, len(doc))
		for i, elem := range doc {
			parts[i] = fmt.Sprintf("%s: %s", elem.Key, FormatValue(elem.Value, 0))
		}
		return "{ " + strings.Join(parts, ", ") + " }"
	}

	var sb strings.Builder
	sb.WriteString("{\n")
	for i, elem := range doc {
		sb.WriteString(innerPrefix)
		sb.WriteString(elem.Key)
		sb.WriteString(": ")
		sb.WriteString(FormatValue(elem.Value, indent+1))
		if i < len(doc)-1 {
			sb.WriteString(",")
		}
		sb.WriteString("\n")
	}
	sb.WriteString(prefix)
	sb.WriteString("}")
	return sb.String()
}

func isSimpleDoc(doc bson.D) bool {
	for _, elem := range doc {
		switch elem.Value.(type) {
		case bson.D, bson.M, bson.A:
			return false
		}
	}
	return true
}

func escapeString(s string) string {
	s = strings.ReplaceAll(s, "\\", "\\\\")
	s = strings.ReplaceAll(s, "'", "\\'")
	s = strings.ReplaceAll(s, "\n", "\\n")
	s = strings.ReplaceAll(s, "\r", "\\r")
	s = strings.ReplaceAll(s, "\t", "\\t")
	return s
}

// FormatDatabaseList formats the output of listDatabases command (mongosh-style GB).
func FormatDatabaseList(databases []bson.M) string {
	var sb strings.Builder
	maxNameLen := 0
	for _, db := range databases {
		name := fmt.Sprintf("%v", db["name"])
		if len(name) > maxNameLen {
			maxNameLen = len(name)
		}
	}

	for _, db := range databases {
		name := fmt.Sprintf("%v", db["name"])
		sizeBytes, _ := db["sizeOnDisk"].(int64)
		if sizeBytes == 0 {
			if s, ok := db["sizeOnDisk"].(int32); ok {
				sizeBytes = int64(s)
			} else if s, ok := db["sizeOnDisk"].(float64); ok {
				sizeBytes = int64(s)
			}
		}
		gb := float64(sizeBytes) / (1024 * 1024 * 1024)
		sb.WriteString(fmt.Sprintf("%-*s  %.3f GB\n", maxNameLen, name, gb))
	}
	return sb.String()
}
