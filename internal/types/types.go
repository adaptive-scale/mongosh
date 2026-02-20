package types

import (
	"fmt"
	"time"

	"github.com/dop251/goja"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// RegisterTypes registers all BSON type constructors in the JS runtime.
func RegisterTypes(vm *goja.Runtime) {
	vm.Set("ObjectId", objectIdConstructor(vm))
	vm.Set("ObjectID", objectIdConstructor(vm))
	vm.Set("NumberLong", numberLongConstructor(vm))
	vm.Set("NumberInt", numberIntConstructor(vm))
	vm.Set("NumberDecimal", numberDecimalConstructor(vm))
	vm.Set("ISODate", isoDateConstructor(vm))
	vm.Set("Date", dateConstructor(vm))
	vm.Set("UUID", uuidConstructor(vm))
	vm.Set("Timestamp", timestampConstructor(vm))
	vm.Set("BinData", binDataConstructor(vm))
	vm.Set("MinKey", minKeyValue(vm))
	vm.Set("MaxKey", maxKeyValue(vm))
}

func objectIdConstructor(vm *goja.Runtime) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		obj := vm.NewObject()
		obj.Set("_bsontype", "ObjectId")

		var oid bson.ObjectID
		if len(call.Arguments) > 0 && !goja.IsUndefined(call.Arguments[0]) {
			hex := call.Arguments[0].String()
			parsed, err := bson.ObjectIDFromHex(hex)
			if err != nil {
				panic(vm.NewTypeError("invalid ObjectId hex string: %s", hex))
			}
			oid = parsed
		} else {
			oid = bson.NewObjectID()
		}

		obj.Set("id", oid.Hex())
		obj.Set("toString", func() string {
			return fmt.Sprintf("ObjectId(\"%s\")", oid.Hex())
		})
		obj.Set("toHexString", func() string {
			return oid.Hex()
		})
		obj.Set("valueOf", func() string {
			return oid.Hex()
		})
		obj.Set("getTimestamp", func() interface{} {
			return oid.Timestamp()
		})
		return obj
	}
}

func numberLongConstructor(vm *goja.Runtime) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		obj := vm.NewObject()
		obj.Set("_bsontype", "NumberLong")

		var val int64
		if len(call.Arguments) > 0 {
			val = call.Arguments[0].ToInteger()
		}

		obj.Set("value", val)
		obj.Set("toString", func() string {
			return fmt.Sprintf("NumberLong(%d)", val)
		})
		obj.Set("valueOf", func() int64 {
			return val
		})
		obj.Set("toNumber", func() float64 {
			return float64(val)
		})
		return obj
	}
}

func numberIntConstructor(vm *goja.Runtime) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		obj := vm.NewObject()
		obj.Set("_bsontype", "NumberInt")

		var val int32
		if len(call.Arguments) > 0 {
			val = int32(call.Arguments[0].ToInteger())
		}

		obj.Set("value", val)
		obj.Set("toString", func() string {
			return fmt.Sprintf("NumberInt(%d)", val)
		})
		obj.Set("valueOf", func() int64 {
			return int64(val)
		})
		return obj
	}
}

func numberDecimalConstructor(vm *goja.Runtime) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		obj := vm.NewObject()
		obj.Set("_bsontype", "NumberDecimal")

		var decStr string
		if len(call.Arguments) > 0 {
			decStr = call.Arguments[0].String()
		} else {
			decStr = "0"
		}

		obj.Set("value", decStr)
		obj.Set("toString", func() string {
			return fmt.Sprintf("NumberDecimal(\"%s\")", decStr)
		})
		return obj
	}
}

func isoDateConstructor(vm *goja.Runtime) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		obj := vm.NewObject()
		obj.Set("_bsontype", "ISODate")

		var t time.Time
		if len(call.Arguments) > 0 && !goja.IsUndefined(call.Arguments[0]) {
			dateStr := call.Arguments[0].String()
			formats := []string{
				time.RFC3339Nano,
				time.RFC3339,
				"2006-01-02T15:04:05.000Z",
				"2006-01-02T15:04:05Z",
				"2006-01-02T15:04:05",
				"2006-01-02",
				"2006/01/02",
			}
			var err error
			parsed := false
			for _, format := range formats {
				t, err = time.Parse(format, dateStr)
				if err == nil {
					parsed = true
					break
				}
			}
			if !parsed {
				panic(vm.NewTypeError("invalid date string: %s", dateStr))
			}
		} else {
			t = time.Now()
		}

		t = t.UTC()
		obj.Set("value", t.Format(time.RFC3339Nano))
		obj.Set("toString", func() string {
			return fmt.Sprintf("ISODate(\"%s\")", t.Format(time.RFC3339Nano))
		})
		obj.Set("valueOf", func() int64 {
			return t.UnixMilli()
		})
		obj.Set("toISOString", func() string {
			return t.Format(time.RFC3339Nano)
		})
		obj.Set("getTime", func() int64 {
			return t.UnixMilli()
		})
		return obj
	}
}

func dateConstructor(vm *goja.Runtime) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			return isoDateConstructor(vm)(call)
		}
		return vm.ToValue(time.Now().UTC().Format(time.RFC1123Z))
	}
}

func uuidConstructor(vm *goja.Runtime) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		obj := vm.NewObject()
		obj.Set("_bsontype", "UUID")

		if len(call.Arguments) > 0 {
			uuidStr := call.Arguments[0].String()
			obj.Set("value", uuidStr)
			obj.Set("toString", func() string {
				return fmt.Sprintf("UUID(\"%s\")", uuidStr)
			})
		} else {
			// Generate a random UUID v4
			id := bson.NewObjectID()
			hex := id.Hex()
			uuidStr := fmt.Sprintf("%s-%s-%s-%s-%s", hex[0:8], hex[8:12], "4"+hex[13:16], "8"+hex[17:20], hex[20:])
			obj.Set("value", uuidStr)
			obj.Set("toString", func() string {
				return fmt.Sprintf("UUID(\"%s\")", uuidStr)
			})
		}
		return obj
	}
}

func timestampConstructor(vm *goja.Runtime) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		obj := vm.NewObject()
		obj.Set("_bsontype", "Timestamp")

		var t, i uint32
		if len(call.Arguments) > 0 {
			t = uint32(call.Arguments[0].ToInteger())
		}
		if len(call.Arguments) > 1 {
			i = uint32(call.Arguments[1].ToInteger())
		}

		obj.Set("t", t)
		obj.Set("i", i)
		obj.Set("toString", func() string {
			return fmt.Sprintf("Timestamp(%d, %d)", t, i)
		})
		return obj
	}
}

func binDataConstructor(vm *goja.Runtime) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		obj := vm.NewObject()
		obj.Set("_bsontype", "BinData")

		var subtype int32
		var data string
		if len(call.Arguments) > 0 {
			subtype = int32(call.Arguments[0].ToInteger())
		}
		if len(call.Arguments) > 1 {
			data = call.Arguments[1].String()
		}

		obj.Set("subtype", subtype)
		obj.Set("data", data)
		obj.Set("toString", func() string {
			return fmt.Sprintf("BinData(%d, \"%s\")", subtype, data)
		})
		return obj
	}
}

func minKeyValue(vm *goja.Runtime) goja.Value {
	obj := vm.NewObject()
	obj.Set("_bsontype", "MinKey")
	obj.Set("toString", func() string { return "MinKey()" })
	return obj
}

func maxKeyValue(vm *goja.Runtime) goja.Value {
	obj := vm.NewObject()
	obj.Set("_bsontype", "MaxKey")
	obj.Set("toString", func() string { return "MaxKey()" })
	return obj
}
