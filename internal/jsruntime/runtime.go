package jsruntime

import (
	"fmt"
	"time"

	"github.com/adaptive-scale/go-mongosh/internal/mongoclient"
	"github.com/adaptive-scale/go-mongosh/internal/types"
	"github.com/dop251/goja"
)

// Runtime wraps a goja.Runtime with mongosh-specific setup.
type Runtime struct {
	VM     *goja.Runtime
	Client *mongoclient.Client

	// RegisterShellObjects is called to register db, rs, sh objects.
	// Set by the caller to avoid import cycles.
	registerShellFn func(vm *goja.Runtime, client *mongoclient.Client)
}

// New creates a new JS runtime. Call RegisterShell() after creation
// to set up db/rs/sh objects (done externally to avoid import cycles).
func New(client *mongoclient.Client) *Runtime {
	vm := goja.New()

	r := &Runtime{
		VM:     vm,
		Client: client,
	}

	// Register type constructors
	types.RegisterTypes(vm)

	// Register utility functions
	r.registerUtils()

	// Register console object
	r.registerConsole()

	return r
}

// RegisterShell registers the db, rs, sh objects using the provided function.
func (r *Runtime) RegisterShell(fn func(vm *goja.Runtime, client *mongoclient.Client)) {
	r.registerShellFn = fn
	fn(r.VM, r.Client)
}

// SwitchDatabase changes the current database and re-registers shell objects.
func (r *Runtime) SwitchDatabase(name string) {
	r.Client.SetCurrentDB(name)
	if r.registerShellFn != nil {
		r.registerShellFn(r.VM, r.Client)
	}
}

// Eval evaluates a JavaScript expression and returns the result.
func (r *Runtime) Eval(code string) (goja.Value, error) {
	return r.VM.RunString(code)
}

// registerUtils registers print, printjson, sleep, load, etc.
func (r *Runtime) registerUtils() {
	r.VM.Set("print", func(call goja.FunctionCall) goja.Value {
		args := make([]interface{}, len(call.Arguments))
		for i, arg := range call.Arguments {
			args[i] = arg.Export()
		}
		fmt.Println(args...)
		return goja.Undefined()
	})

	r.VM.Set("printjson", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			val := call.Arguments[0].Export()
			fmt.Println(formatJSONValue(val, 0))
		}
		return goja.Undefined()
	})

	r.VM.Set("sleep", func(ms int64) {
		time.Sleep(time.Duration(ms) * time.Millisecond)
	})

	r.VM.Set("version", func() string {
		v, _ := r.Client.ServerVersion()
		return v
	})

	r.VM.Set("hostname", func() string {
		return "go-mongosh"
	})

	r.VM.Set("tojson", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			val := call.Arguments[0].Export()
			return r.VM.ToValue(formatJSONValue(val, 0))
		}
		return r.VM.ToValue("")
	})

	r.VM.Set("tojsononeline", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			val := call.Arguments[0].Export()
			return r.VM.ToValue(fmt.Sprintf("%v", val))
		}
		return r.VM.ToValue("")
	})
}

// registerConsole sets up console.log, console.error, etc.
func (r *Runtime) registerConsole() {
	console := r.VM.NewObject()
	console.Set("log", func(call goja.FunctionCall) goja.Value {
		args := make([]interface{}, len(call.Arguments))
		for i, arg := range call.Arguments {
			args[i] = arg.Export()
		}
		fmt.Println(args...)
		return goja.Undefined()
	})
	console.Set("error", func(call goja.FunctionCall) goja.Value {
		args := make([]interface{}, len(call.Arguments))
		for i, arg := range call.Arguments {
			args[i] = arg.Export()
		}
		fmt.Println(args...)
		return goja.Undefined()
	})
	console.Set("warn", func(call goja.FunctionCall) goja.Value {
		args := make([]interface{}, len(call.Arguments))
		for i, arg := range call.Arguments {
			args[i] = arg.Export()
		}
		fmt.Println(args...)
		return goja.Undefined()
	})
	r.VM.Set("console", console)
}

func formatJSONValue(val interface{}, indent int) string {
	switch v := val.(type) {
	case map[string]interface{}:
		return fmt.Sprintf("%v", v)
	case []interface{}:
		return fmt.Sprintf("%v", v)
	default:
		return fmt.Sprintf("%v", v)
	}
}
