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
	runtime   *jsruntime.Runtime
	client    *mongoclient.Client
	completer *Completer
	liner     *liner.State
	lastCursor interface{} // stores last cursor for "it" iteration
	quiet     bool
}

// New creates a new REPL.
func New(rt *jsruntime.Runtime, client *mongoclient.Client, quiet bool) *REPL {
	return &REPL{
		runtime:   rt,
		client:    client,
		completer: NewCompleter(client),
		quiet:     quiet,
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
			fmt.Println("\nbye")
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
	version, _ := r.client.ServerVersion()
	fmt.Println("go-mongosh — MongoDB Shell in Go")
	fmt.Printf("Connecting to: %s\n", r.client.CurrentDBName())
	if version != "" {
		fmt.Printf("MongoDB server version: %s\n", version)
	}
	fmt.Println("Type \"help\" for help, \"exit\" to quit")
	fmt.Println()
}

// handleShellCommand processes special shell commands. Returns true if handled.
func (r *REPL) handleShellCommand(input string) bool {
	lower := strings.TrimSpace(strings.ToLower(input))

	switch {
	case lower == "exit" || lower == "exit()" || lower == "quit" || lower == "quit()" || lower == ".exit":
		fmt.Println("bye")
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
	val, err := r.runtime.Eval("db.adminCommand({listDatabases: 1})")
	if err != nil {
		fmt.Printf("Error: %v\n", err)
		return
	}

	exported := val.Export()
	if m, ok := exported.(map[string]interface{}); ok {
		// Convert to bson.D for formatting
		if dbs, ok := m["databases"].([]interface{}); ok {
			for _, db := range dbs {
				if dbMap, ok := db.(map[string]interface{}); ok {
					name := fmt.Sprintf("%v", dbMap["name"])
					var size int64
					switch v := dbMap["sizeOnDisk"].(type) {
					case int64:
						size = v
					case float64:
						size = int64(v)
					}
					sizeStr := formatSizeBytes(size)
					fmt.Printf("%-20s %s\n", name, sizeStr)
				}
			}
		}
	} else {
		// Try as bson.D
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
		fmt.Printf("Error: %v\n", err)
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
		// Check for goja exception
		if ex, ok := err.(*goja.Exception); ok {
			fmt.Printf("Error: %s\n", ex.Value().String())
		} else {
			fmt.Printf("Error: %v\n", err)
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

	// Call toArray internally to get first batch
	toArrayFn := obj.Get("toArray")
	if toArrayFn == nil || goja.IsUndefined(toArrayFn) {
		fmt.Println(val2str(cursorVal.Export()))
		return
	}

	// Use hasNext/next for batch printing
	hasNextFn, hasNextOk := goja.AssertFunction(obj.Get("hasNext"))
	nextFn, nextOk := goja.AssertFunction(obj.Get("next"))

	if !hasNextOk || !nextOk {
		// Fallback to toArray
		fn, ok := goja.AssertFunction(toArrayFn)
		if !ok {
			return
		}
		result, err := fn(cursorVal)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
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
			fmt.Printf("Error: %v\n", err)
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
		// Check for _bsontype marker
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
	fmt.Println(`go-mongosh Help:

Shell Commands:
  show dbs                       List databases
  show collections               List collections in current db
  show users                     List users in current db
  show roles                     List roles in current db
  use <database>                 Switch database
  db                             Print current database name
  it                             Iterate next batch of cursor results
  cls                            Clear screen
  exit / quit                    Exit the shell

Database Methods:         Type db.help() for more
Collection Methods:       Type db.<collection>.help() for more
Replica Set Methods:      Type rs.help() for more
Sharding Methods:         Type sh.help() for more

Type Constructors:
  ObjectId()                     Create a new ObjectId
  ISODate()                      Create an ISODate
  NumberLong(n)                  Create a 64-bit integer
  NumberInt(n)                   Create a 32-bit integer
  NumberDecimal(s)               Create a decimal128
  UUID()                         Generate a UUID
  Timestamp(t, i)                Create a timestamp`)
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

	// Also check for trailing backslash
	if len(input) > 0 && input[len(input)-1] == '\\' {
		return true
	}

	return opens > 0 || inString
}

func val2str(v interface{}) string {
	return fmt.Sprintf("%v", v)
}

func formatSizeBytes(bytes int64) string {
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
