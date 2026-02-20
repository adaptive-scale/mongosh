package repl

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/adaptive-scale/go-mongosh/internal/convert"
	"github.com/adaptive-scale/go-mongosh/internal/jsruntime"
	"github.com/adaptive-scale/go-mongosh/internal/mongoclient"
	"github.com/adaptive-scale/go-mongosh/internal/output"
	"github.com/adaptive-scale/go-mongosh/internal/shell"
	"github.com/dop251/goja"
	"github.com/peterh/liner"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// REPL represents the interactive shell.
type REPL struct {
	runtime    *jsruntime.Runtime
	client     *mongoclient.Client
	completer  *Completer
	liner      *liner.State
	lastCursor interface{} // stores last cursor for "it" iteration
	quiet      bool
	version    string
}

// New creates a new REPL.
func New(rt *jsruntime.Runtime, client *mongoclient.Client, quiet bool, version string) *REPL {
	return &REPL{
		runtime:   rt,
		client:    client,
		completer: NewCompleter(client),
		quiet:     quiet,
		version:   version,
	}
}

// Run starts the REPL loop.
func (r *REPL) Run() {
	r.liner = liner.NewLiner()
	defer r.liner.Close()

	r.liner.SetCtrlCAborts(true)
	r.liner.SetMultiLineMode(true)

	// Tab completion
	r.liner.SetCompleter(func(line string) []string {
		return r.completer.Complete(line)
	})

	// Load history
	historyPath := r.historyPath()
	if f, err := os.Open(historyPath); err == nil {
		r.liner.ReadHistory(f)
		f.Close()
	}

	if !r.quiet {
		r.printBanner()
	}

	for {
		prompt := r.getPrompt()
		input, err := r.liner.Prompt(prompt)
		if err != nil {
			if err == liner.ErrPromptAborted {
				continue
			}
			// EOF (Ctrl+D)
			fmt.Println()
			break
		}

		input = strings.TrimSpace(input)
		if input == "" {
			continue
		}

		// Check for multiline input
		for isIncomplete(input) {
			continuation, err := r.liner.Prompt("... ")
			if err != nil {
				break
			}
			input += "\n" + continuation
		}

		r.liner.AppendHistory(input)

		// Handle special shell commands
		if r.handleShellCommand(input) {
			continue
		}

		// Evaluate JavaScript
		r.evalAndPrint(input)
	}

	// Save history
	r.saveHistory()
}

func (r *REPL) getPrompt() string {
	return r.client.CurrentDBName() + "> "
}

func (r *REPL) printBanner() {
	serverVersion, _ := r.client.ServerVersion()
	if serverVersion != "" {
		fmt.Printf("Using MongoDB:\t\t%s\n", serverVersion)
	}
	fmt.Printf("Using Mongosh:\t\t%s\n", r.version)
	fmt.Println()
	fmt.Println("For mongosh info see: https://docs.mongodb.com/mongodb-shell/")
	fmt.Println()
}

// handleShellCommand processes special shell commands. Returns true if handled.
func (r *REPL) handleShellCommand(input string) bool {
	lower := strings.TrimSpace(strings.ToLower(input))

	switch {
	case lower == "exit" || lower == "exit()" || lower == "quit" || lower == "quit()" || lower == ".exit":
		r.saveHistory()
		os.Exit(0)
		return true

	case lower == "cls":
		fmt.Print("\033[H\033[2J")
		return true

	case lower == "help" || lower == "help()":
		r.printHelp()
		return true

	case lower == "show dbs" || lower == "show databases":
		r.showDatabases()
		return true

	case lower == "show collections" || lower == "show tables":
		r.showCollections()
		return true

	case lower == "show users":
		r.evalAndPrint("db.getUsers()")
		return true

	case lower == "show roles":
		r.evalAndPrint("db.getRoles()")
		return true

	case lower == "show profile":
		r.evalAndPrint("db.system.profile.find().sort({ts: -1}).limit(5)")
		return true

	case strings.HasPrefix(lower, "use "):
		dbName := strings.TrimSpace(input[4:])
		r.runtime.SwitchDatabase(dbName)
		fmt.Printf("switched to db %s\n", dbName)
		return true

	case lower == "it":
		r.iterateCursor()
		return true

	case lower == "db":
		fmt.Println(r.client.CurrentDBName())
		return true
	}

	return false
}

func (r *REPL) showDatabases() {
	val, err := r.runtime.Eval("db.adminCommand({listDatabases: 1, nameOnly: false, authorizedDatabases: true})")
	if err != nil {
		fmt.Printf("MongoServerError: %v\n", err)
		return
	}

	exported := val.Export()
	if m, ok := exported.(map[string]interface{}); ok {
		if dbs, ok := m["databases"].([]interface{}); ok {
			maxLen := 0
			type dbInfo struct {
				name string
				size int64
			}
			var infos []dbInfo
			for _, db := range dbs {
				if dbMap, ok := db.(map[string]interface{}); ok {
					info := dbInfo{}
					info.name = fmt.Sprintf("%v", dbMap["name"])
					switch v := dbMap["sizeOnDisk"].(type) {
					case int64:
						info.size = v
					case float64:
						info.size = int64(v)
					case int32:
						info.size = int64(v)
					}
					if len(info.name) > maxLen {
						maxLen = len(info.name)
					}
					infos = append(infos, info)
				}
			}
			for _, info := range infos {
				fmt.Printf("%-*s  %s\n", maxLen, info.name, formatSizeGB(info.size))
			}
		}
	} else {
		if bsonResult := convert.JSToGo(r.runtime.VM, val); bsonResult != nil {
			if doc, ok := bsonResult.(bson.D); ok {
				fmt.Print(shell.FormatShowDbs(doc))
			}
		}
	}
}

func (r *REPL) showCollections() {
	val, err := r.runtime.Eval("db.getCollectionNames()")
	if err != nil {
		fmt.Printf("MongoServerError: %v\n", err)
		return
	}

	exported := val.Export()
	if arr, ok := exported.([]interface{}); ok {
		for _, name := range arr {
			fmt.Println(name)
		}
	}
}

func (r *REPL) evalAndPrint(input string) {
	val, err := r.runtime.Eval(input)
	if err != nil {
		if ex, ok := err.(*goja.Exception); ok {
			errStr := ex.Value().String()
			if strings.Contains(errStr, "command failed") {
				fmt.Printf("MongoServerError: %s\n", errStr)
			} else {
				fmt.Printf("MongoshInvalidInputError: %s\n", errStr)
			}
		} else {
			fmt.Printf("MongoshInvalidInputError: %v\n", err)
		}
		return
	}

	if val == nil || goja.IsUndefined(val) || goja.IsNull(val) {
		if goja.IsNull(val) {
			fmt.Println("null")
		}
		return
	}

	// Check if result is a cursor (has _isCursor property)
	if obj, ok := val.(*goja.Object); ok {
		isCursor := obj.Get("_isCursor")
		if isCursor != nil && !goja.IsUndefined(isCursor) && isCursor.ToBoolean() {
			r.printCursorResults(val)
			return
		}
	}

	// Regular value - format and print
	exported := val.Export()
	r.printValue(exported)
}

func (r *REPL) printCursorResults(cursorVal goja.Value) {
	obj := cursorVal.ToObject(r.runtime.VM)

	toArrayFn := obj.Get("toArray")
	if toArrayFn == nil || goja.IsUndefined(toArrayFn) {
		fmt.Println(val2str(cursorVal.Export()))
		return
	}

	// Use hasNext/next for batch printing
	hasNextFn, hasNextOk := goja.AssertFunction(obj.Get("hasNext"))
	nextFn, nextOk := goja.AssertFunction(obj.Get("next"))

	if !hasNextOk || !nextOk {
		fn, ok := goja.AssertFunction(toArrayFn)
		if !ok {
			return
		}
		result, err := fn(cursorVal)
		if err != nil {
			fmt.Printf("MongoServerError: %v\n", err)
			return
		}
		r.printValue(result.Export())
		return
	}

	count := 0
	for count < 20 {
		hasNext, err := hasNextFn(cursorVal)
		if err != nil || !hasNext.ToBoolean() {
			break
		}

		doc, err := nextFn(cursorVal)
		if err != nil {
			fmt.Printf("MongoServerError: %v\n", err)
			break
		}

		r.printValue(doc.Export())
		count++
	}

	// Check if there are more
	hasMore, err := hasNextFn(cursorVal)
	if err == nil && hasMore.ToBoolean() {
		r.lastCursor = cursorVal
		fmt.Println("Type \"it\" for more")
	} else {
		r.lastCursor = nil
	}
}

func (r *REPL) iterateCursor() {
	if r.lastCursor == nil {
		fmt.Println("no cursor")
		return
	}

	cursorVal, ok := r.lastCursor.(goja.Value)
	if !ok {
		fmt.Println("no cursor")
		return
	}

	r.printCursorResults(cursorVal)
}

func (r *REPL) printValue(val interface{}) {
	switch v := val.(type) {
	case string:
		fmt.Println(v)
	case bool:
		fmt.Println(v)
	case int64:
		fmt.Println(v)
	case float64:
		fmt.Println(v)
	case nil:
		fmt.Println("null")
	case map[string]interface{}:
		if bt, ok := v["_bsontype"]; ok {
			if ts, ok := v["toString"]; ok {
				if fn, ok := ts.(func() string); ok {
					fmt.Println(fn())
					return
				}
			}
			fmt.Println(bt)
			return
		}
		doc := mapToBsonD(v)
		fmt.Println(output.FormatValue(doc, 0))
	case []interface{}:
		arr := bson.A{}
		for _, item := range v {
			if m, ok := item.(map[string]interface{}); ok {
				arr = append(arr, mapToBsonD(m))
			} else {
				arr = append(arr, item)
			}
		}
		fmt.Println(output.FormatValue(arr, 0))
	case bson.D:
		fmt.Println(output.FormatValue(v, 0))
	default:
		fmt.Printf("%v\n", v)
	}
}

func mapToBsonD(m map[string]interface{}) bson.D {
	doc := bson.D{}
	for k, v := range m {
		if k == "_bsontype" || k == "toString" || k == "valueOf" || k == "toHexString" || k == "getTimestamp" || k == "toISOString" || k == "getTime" || k == "toNumber" {
			continue
		}
		switch val := v.(type) {
		case map[string]interface{}:
			if bt, ok := val["_bsontype"]; ok {
				switch bt {
				case "ObjectId":
					if id, ok := val["id"].(string); ok {
						oid, err := bson.ObjectIDFromHex(id)
						if err == nil {
							doc = append(doc, bson.E{Key: k, Value: oid})
							continue
						}
					}
				case "ISODate":
					if dateStr, ok := val["value"].(string); ok {
						doc = append(doc, bson.E{Key: k, Value: "ISODate(\"" + dateStr + "\")"})
						continue
					}
				case "NumberLong":
					if num, ok := val["value"].(int64); ok {
						doc = append(doc, bson.E{Key: k, Value: num})
						continue
					}
				}
			}
			doc = append(doc, bson.E{Key: k, Value: mapToBsonD(val)})
		case []interface{}:
			arr := bson.A{}
			for _, item := range val {
				if m, ok := item.(map[string]interface{}); ok {
					arr = append(arr, mapToBsonD(m))
				} else {
					arr = append(arr, item)
				}
			}
			doc = append(doc, bson.E{Key: k, Value: arr})
		default:
			doc = append(doc, bson.E{Key: k, Value: v})
		}
	}
	return doc
}

func (r *REPL) printHelp() {
	fmt.Println(`Shell Help:

    use                                        Set current database
    show                                       'show databases'/'show collections'/'show profile'/'show users'/'show roles'
    exit                                       Quit the MongoDB shell
    db                                         Print current database name
    it                                         Result of the last line evaluated; use to further iterate
    cls                                        Clear the terminal screen

    help                                       Show this help

  For more info, see: https://docs.mongodb.com/mongodb-shell/

  Database Methods:         Type db.help() for more
  Collection Methods:       Type db.<collection>.help() for more
  Replica Set Methods:      Type rs.help() for more
  Sharding Methods:         Type sh.help() for more`)
}

func (r *REPL) historyPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ".go_mongosh_history"
	}
	return filepath.Join(home, ".go_mongosh_history")
}

func (r *REPL) saveHistory() {
	if r.liner == nil {
		return
	}
	historyPath := r.historyPath()
	if f, err := os.Create(historyPath); err == nil {
		r.liner.WriteHistory(f)
		f.Close()
	}
}

// isIncomplete checks if the input has unmatched brackets/braces/parens.
func isIncomplete(input string) bool {
	opens := 0
	inString := false
	stringChar := byte(0)
	escaped := false

	for i := 0; i < len(input); i++ {
		ch := input[i]

		if escaped {
			escaped = false
			continue
		}

		if ch == '\\' && inString {
			escaped = true
			continue
		}

		if inString {
			if ch == stringChar {
				inString = false
			}
			continue
		}

		switch ch {
		case '"', '\'', '`':
			inString = true
			stringChar = ch
		case '{', '(', '[':
			opens++
		case '}', ')', ']':
			opens--
		}
	}

	if len(input) > 0 && input[len(input)-1] == '\\' {
		return true
	}

	return opens > 0 || inString
}

func val2str(v interface{}) string {
	return fmt.Sprintf("%v", v)
}

// formatSizeGB formats bytes as GB like real mongosh: "0.007GB"
func formatSizeGB(bytes int64) string {
	gb := float64(bytes) / (1024 * 1024 * 1024)
	if gb < 0.001 {
		return fmt.Sprintf("%.3f GB", gb)
	}
	return fmt.Sprintf("%.3f GB", gb)
}
