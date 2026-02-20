package convert

import (
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/dop251/goja"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// JSToGo converts a goja JavaScript value to a Go value suitable for BSON.
// JS objects are converted to bson.D to preserve key order.
func JSToGo(vm *goja.Runtime, val goja.Value) interface{} {
	if val == nil || goja.IsUndefined(val) || goja.IsNull(val) {
		return nil
	}

	exported := val.Export()

	switch v := exported.(type) {
	case map[string]interface{}:
		return mapToBsonD(vm, v, val)
	case []interface{}:
		arr := bson.A{}
		obj := val.ToObject(vm)
		length := obj.Get("length")
		if length != nil {
			l := int(length.ToInteger())
			for i := 0; i < l; i++ {
				elem := obj.Get(fmt.Sprintf("%d", i))
				arr = append(arr, JSToGo(vm, elem))
			}
			return arr
		}
		for _, item := range v {
			arr = append(arr, convertGoValue(item))
		}
		return arr
	case int64:
		if v >= math.MinInt32 && v <= math.MaxInt32 {
			return int32(v)
		}
		return v
	case float64:
		if v == math.Trunc(v) && v >= math.MinInt32 && v <= math.MaxInt32 {
			return int32(v)
		}
		return v
	case bool, string:
		return v
	case time.Time:
		return bson.DateTime(v.UnixMilli())
	default:
		if obj, ok := val.(*goja.Object); ok {
			return extractBsonType(vm, obj)
		}
		return exported
	}
}

func mapToBsonD(vm *goja.Runtime, m map[string]interface{}, val goja.Value) bson.D {
	doc := bson.D{}

	if val != nil {
		obj := val.ToObject(vm)
		keys := obj.Keys()
		for _, key := range keys {
			v := obj.Get(key)
			doc = append(doc, bson.E{Key: key, Value: JSToGo(vm, v)})
		}
		return doc
	}

	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		doc = append(doc, bson.E{Key: k, Value: convertGoValue(m[k])})
	}
	return doc
}

func convertGoValue(v interface{}) interface{} {
	switch val := v.(type) {
	case map[string]interface{}:
		doc := bson.D{}
		keys := make([]string, 0, len(val))
		for k := range val {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			doc = append(doc, bson.E{Key: k, Value: convertGoValue(val[k])})
		}
		return doc
	case []interface{}:
		arr := bson.A{}
		for _, item := range val {
			arr = append(arr, convertGoValue(item))
		}
		return arr
	case float64:
		if val == math.Trunc(val) && val >= math.MinInt32 && val <= math.MaxInt32 {
			return int32(val)
		}
		return val
	default:
		return v
	}
}

func extractBsonType(vm *goja.Runtime, obj *goja.Object) interface{} {
	bsonType := obj.Get("_bsontype")
	if bsonType == nil || goja.IsUndefined(bsonType) {
		doc := bson.D{}
		for _, key := range obj.Keys() {
			v := obj.Get(key)
			doc = append(doc, bson.E{Key: key, Value: JSToGo(vm, v)})
		}
		return doc
	}

	switch bsonType.String() {
	case "ObjectId":
		hexVal := obj.Get("id")
		if hexVal != nil {
			hex := hexVal.String()
			oid, err := bson.ObjectIDFromHex(hex)
			if err == nil {
				return oid
			}
		}
		return bson.NewObjectID()
	case "NumberLong":
		v := obj.Get("value")
		if v != nil {
			return v.ToInteger()
		}
		return int64(0)
	case "NumberInt":
		v := obj.Get("value")
		if v != nil {
			return int32(v.ToInteger())
		}
		return int32(0)
	case "NumberDecimal":
		v := obj.Get("value")
		if v != nil {
			d, err := bson.ParseDecimal128(v.String())
			if err == nil {
				return d
			}
		}
		return bson.Decimal128{}
	case "ISODate":
		v := obj.Get("value")
		if v != nil {
			t, err := time.Parse(time.RFC3339Nano, v.String())
			if err == nil {
				return bson.DateTime(t.UnixMilli())
			}
			t, err = time.Parse("2006-01-02", v.String())
			if err == nil {
				return bson.DateTime(t.UnixMilli())
			}
			t, err = time.Parse("2006-01-02T15:04:05Z", v.String())
			if err == nil {
				return bson.DateTime(t.UnixMilli())
			}
		}
		return bson.DateTime(time.Now().UnixMilli())
	case "Timestamp":
		t := obj.Get("t")
		i := obj.Get("i")
		ts := bson.Timestamp{}
		if t != nil {
			ts.T = uint32(t.ToInteger())
		}
		if i != nil {
			ts.I = uint32(i.ToInteger())
		}
		return ts
	default:
		return obj.Export()
	}
}

// GoToJS converts a Go/BSON value to a goja JavaScript value.
func GoToJS(vm *goja.Runtime, val interface{}) goja.Value {
	if val == nil {
		return goja.Null()
	}

	switch v := val.(type) {
	case bson.D:
		obj := vm.NewObject()
		for _, elem := range v {
			obj.Set(elem.Key, GoToJS(vm, elem.Value))
		}
		return obj
	case bson.M:
		obj := vm.NewObject()
		for key, value := range v {
			obj.Set(key, GoToJS(vm, value))
		}
		return obj
	case bson.A:
		arr := make([]interface{}, len(v))
		for i, item := range v {
			arr[i] = goToNative(item)
		}
		return vm.ToValue(arr)
	case bson.ObjectID:
		return MakeObjectIdJS(vm, v)
	case bson.DateTime:
		t := time.UnixMilli(int64(v))
		return MakeISODateJS(vm, t)
	case bson.Decimal128:
		return MakeDecimalJS(vm, v)
	case bson.Timestamp:
		return MakeTimestampJS(vm, v)
	case bson.Regex:
		obj := vm.NewObject()
		obj.Set("pattern", v.Pattern)
		obj.Set("options", v.Options)
		return obj
	case bson.Binary:
		obj := vm.NewObject()
		obj.Set("subType", v.Subtype)
		obj.Set("data", fmt.Sprintf("%x", v.Data))
		return obj
	case int32:
		return vm.ToValue(int64(v))
	case int64:
		return vm.ToValue(v)
	case float64:
		return vm.ToValue(v)
	case string:
		return vm.ToValue(v)
	case bool:
		return vm.ToValue(v)
	case time.Time:
		return MakeISODateJS(vm, v)
	default:
		return vm.ToValue(v)
	}
}

// MakeObjectIdJS creates a JS ObjectId object.
func MakeObjectIdJS(vm *goja.Runtime, oid bson.ObjectID) goja.Value {
	obj := vm.NewObject()
	obj.Set("_bsontype", "ObjectId")
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

// MakeISODateJS creates a JS ISODate object.
func MakeISODateJS(vm *goja.Runtime, t time.Time) goja.Value {
	obj := vm.NewObject()
	obj.Set("_bsontype", "ISODate")
	obj.Set("value", t.UTC().Format(time.RFC3339Nano))
	obj.Set("toString", func() string {
		return fmt.Sprintf("ISODate(\"%s\")", t.UTC().Format(time.RFC3339Nano))
	})
	obj.Set("valueOf", func() int64 {
		return t.UnixMilli()
	})
	obj.Set("toISOString", func() string {
		return t.UTC().Format(time.RFC3339Nano)
	})
	return obj
}

// MakeDecimalJS creates a JS NumberDecimal object.
func MakeDecimalJS(vm *goja.Runtime, d bson.Decimal128) goja.Value {
	obj := vm.NewObject()
	obj.Set("_bsontype", "NumberDecimal")
	obj.Set("value", d.String())
	obj.Set("toString", func() string {
		return fmt.Sprintf("NumberDecimal(\"%s\")", d.String())
	})
	return obj
}

// MakeTimestampJS creates a JS Timestamp object.
func MakeTimestampJS(vm *goja.Runtime, ts bson.Timestamp) goja.Value {
	obj := vm.NewObject()
	obj.Set("_bsontype", "Timestamp")
	obj.Set("t", ts.T)
	obj.Set("i", ts.I)
	obj.Set("toString", func() string {
		return fmt.Sprintf("Timestamp(%d, %d)", ts.T, ts.I)
	})
	return obj
}

func goToNative(val interface{}) interface{} {
	switch v := val.(type) {
	case bson.D:
		m := make(map[string]interface{})
		for _, elem := range v {
			m[elem.Key] = goToNative(elem.Value)
		}
		return m
	case bson.A:
		arr := make([]interface{}, len(v))
		for i, item := range v {
			arr[i] = goToNative(item)
		}
		return arr
	case bson.ObjectID:
		return v.Hex()
	case bson.DateTime:
		return time.UnixMilli(int64(v)).UTC().Format(time.RFC3339Nano)
	case int32:
		return int64(v)
	default:
		return v
	}
}
