package shell

// admin.go contains shared helpers used by db.go for user/role management
// and administrative commands. The actual command dispatch is in db.go;
// this file provides the output formatting reference.

import (
	"fmt"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// FormatShowDbs formats the output of the listDatabases command for "show dbs".
func FormatShowDbs(result bson.D) string {
	var output string
	for _, elem := range result {
		if elem.Key == "databases" {
			if dbs, ok := elem.Value.(bson.A); ok {
				maxLen := 0
				type dbInfo struct {
					name string
					size int64
				}
				var infos []dbInfo
				for _, db := range dbs {
					if doc, ok := db.(bson.D); ok {
						info := dbInfo{}
						for _, field := range doc {
							switch field.Key {
							case "name":
								info.name = fmt.Sprintf("%v", field.Value)
							case "sizeOnDisk":
								switch v := field.Value.(type) {
								case int64:
									info.size = v
								case int32:
									info.size = int64(v)
								case float64:
									info.size = int64(v)
								}
							}
						}
						if len(info.name) > maxLen {
							maxLen = len(info.name)
						}
						infos = append(infos, info)
					}
				}
				for _, info := range infos {
					output += fmt.Sprintf("%-*s  %s\n", maxLen, info.name, formatBytes(info.size))
				}
			}
		}
	}
	return output
}

func formatBytes(bytes int64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%d B", bytes)
	}
	kb := float64(bytes) / 1024
	if kb < 1024 {
		return fmt.Sprintf("%.2f KiB", kb)
	}
	mb := kb / 1024
	if mb < 1024 {
		return fmt.Sprintf("%.2f MiB", mb)
	}
	gb := mb / 1024
	return fmt.Sprintf("%.2f GiB", gb)
}
