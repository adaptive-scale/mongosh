package shell

import (
	"context"
	"fmt"
	"time"

	"github.com/adaptive-scale/go-mongosh/internal/convert"
	"github.com/adaptive-scale/go-mongosh/internal/output"
	"github.com/dop251/goja"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

const defaultBatchSize = 20

// Cursor implements lazy MongoDB cursor with chainable methods.
type Cursor struct {
	vm         *goja.Runtime
	collection *mongo.Collection
	filter     interface{}

	// Options built up via chaining
	sortVal      interface{}
	limitVal     *int64
	skipVal      *int64
	projectionVal interface{}
	batchSizeVal *int32
	hintVal      interface{}
	commentVal   string
	collationVal *options.Collation
	minVal       interface{}
	maxVal       interface{}
	allowDisk    bool

	// Execution state
	executed    bool
	cursor      *mongo.Cursor
	prettyMode  bool
	documents   []bson.D
	position    int
	exhausted   bool
}

// NewCursor creates a new lazy cursor.
func NewCursor(vm *goja.Runtime, coll *mongo.Collection, filter interface{}) *Cursor {
	if filter == nil {
		filter = bson.D{}
	}
	return &Cursor{
		vm:         vm,
		collection: coll,
		filter:     filter,
	}
}

// ToJSObject converts the cursor to a JS object with all methods.
func (c *Cursor) ToJSObject() goja.Value {
	obj := c.vm.NewObject()
	obj.Set("_isCursor", true)

	// Chaining methods
	obj.Set("sort", c.jsSort(obj))
	obj.Set("limit", c.jsLimit(obj))
	obj.Set("skip", c.jsSkip(obj))
	obj.Set("projection", c.jsProjection(obj))
	obj.Set("batchSize", c.jsBatchSize(obj))
	obj.Set("hint", c.jsHint(obj))
	obj.Set("comment", c.jsComment(obj))
	obj.Set("collation", c.jsCollation(obj))
	obj.Set("min", c.jsMin(obj))
	obj.Set("max", c.jsMax(obj))
	obj.Set("allowDiskUse", c.jsAllowDiskUse(obj))
	obj.Set("pretty", c.jsPretty(obj))

	// Terminal methods
	obj.Set("toArray", c.jsToArray())
	obj.Set("forEach", c.jsForEach())
	obj.Set("map", c.jsMap())
	obj.Set("hasNext", c.jsHasNext())
	obj.Set("next", c.jsNext())
	obj.Set("count", c.jsCount())
	obj.Set("size", c.jsCount()) // alias
	obj.Set("itcount", c.jsItCount())
	obj.Set("close", c.jsClose())
	obj.Set("explain", c.jsExplain())

	return obj
}

func (c *Cursor) jsSort(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			c.sortVal = convert.JSToGo(c.vm, call.Arguments[0])
		}
		return self
	}
}

func (c *Cursor) jsLimit(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			l := call.Arguments[0].ToInteger()
			c.limitVal = &l
		}
		return self
	}
}

func (c *Cursor) jsSkip(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			s := call.Arguments[0].ToInteger()
			c.skipVal = &s
		}
		return self
	}
}

func (c *Cursor) jsProjection(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			c.projectionVal = convert.JSToGo(c.vm, call.Arguments[0])
		}
		return self
	}
}

func (c *Cursor) jsBatchSize(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			b := int32(call.Arguments[0].ToInteger())
			c.batchSizeVal = &b
		}
		return self
	}
}

func (c *Cursor) jsHint(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			c.hintVal = convert.JSToGo(c.vm, call.Arguments[0])
		}
		return self
	}
}

func (c *Cursor) jsComment(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			c.commentVal = call.Arguments[0].String()
		}
		return self
	}
}

func (c *Cursor) jsCollation(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			exported := call.Arguments[0].Export()
			if m, ok := exported.(map[string]interface{}); ok {
				c.collationVal = &options.Collation{}
				if locale, ok := m["locale"].(string); ok {
					c.collationVal.Locale = locale
				}
				if strength, ok := m["strength"].(int64); ok {
					c.collationVal.Strength = int(strength)
				}
			}
		}
		return self
	}
}

func (c *Cursor) jsMin(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			c.minVal = convert.JSToGo(c.vm, call.Arguments[0])
		}
		return self
	}
}

func (c *Cursor) jsMax(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) > 0 {
			c.maxVal = convert.JSToGo(c.vm, call.Arguments[0])
		}
		return self
	}
}

func (c *Cursor) jsAllowDiskUse(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		c.allowDisk = true
		return self
	}
}

func (c *Cursor) jsPretty(self *goja.Object) func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		c.prettyMode = true
		return self
	}
}

// execute runs the find query if not already executed.
func (c *Cursor) execute() error {
	if c.executed {
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	opts := options.Find()
	if c.sortVal != nil {
		opts.SetSort(c.sortVal)
	}
	if c.limitVal != nil {
		opts.SetLimit(*c.limitVal)
	}
	if c.skipVal != nil {
		opts.SetSkip(*c.skipVal)
	}
	if c.projectionVal != nil {
		opts.SetProjection(c.projectionVal)
	}
	if c.batchSizeVal != nil {
		opts.SetBatchSize(*c.batchSizeVal)
	}
	if c.hintVal != nil {
		opts.SetHint(c.hintVal)
	}
	if c.commentVal != "" {
		opts.SetComment(c.commentVal)
	}
	if c.collationVal != nil {
		opts.SetCollation(c.collationVal)
	}
	if c.minVal != nil {
		opts.SetMin(c.minVal)
	}
	if c.maxVal != nil {
		opts.SetMax(c.maxVal)
	}
	if c.allowDisk {
		opts.SetAllowDiskUse(true)
	}

	cursor, err := c.collection.Find(ctx, c.filter, opts)
	if err != nil {
		return err
	}

	c.cursor = cursor
	c.executed = true
	return nil
}

func (c *Cursor) jsToArray() func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if err := c.execute(); err != nil {
			panic(c.vm.NewGoError(err))
		}

		ctx := context.Background()
		var results []bson.D
		if err := c.cursor.All(ctx, &results); err != nil {
			panic(c.vm.NewGoError(err))
		}

		arr := make([]interface{}, len(results))
		for i, doc := range results {
			arr[i] = convert.GoToJS(c.vm, doc).Export()
		}
		return c.vm.ToValue(arr)
	}
}

func (c *Cursor) jsForEach() func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) < 1 {
			panic(c.vm.NewTypeError("forEach requires a callback function"))
		}

		fn, ok := goja.AssertFunction(call.Arguments[0])
		if !ok {
			panic(c.vm.NewTypeError("forEach requires a callback function"))
		}

		if err := c.execute(); err != nil {
			panic(c.vm.NewGoError(err))
		}

		ctx := context.Background()
		for c.cursor.Next(ctx) {
			var doc bson.D
			if err := c.cursor.Decode(&doc); err != nil {
				panic(c.vm.NewGoError(err))
			}
			jsDoc := convert.GoToJS(c.vm, doc)
			_, err := fn(goja.Undefined(), jsDoc)
			if err != nil {
				panic(err)
			}
		}
		return goja.Undefined()
	}
}

func (c *Cursor) jsMap() func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) < 1 {
			panic(c.vm.NewTypeError("map requires a callback function"))
		}

		fn, ok := goja.AssertFunction(call.Arguments[0])
		if !ok {
			panic(c.vm.NewTypeError("map requires a callback function"))
		}

		if err := c.execute(); err != nil {
			panic(c.vm.NewGoError(err))
		}

		ctx := context.Background()
		var results []interface{}
		for c.cursor.Next(ctx) {
			var doc bson.D
			if err := c.cursor.Decode(&doc); err != nil {
				panic(c.vm.NewGoError(err))
			}
			jsDoc := convert.GoToJS(c.vm, doc)
			result, err := fn(goja.Undefined(), jsDoc)
			if err != nil {
				panic(err)
			}
			results = append(results, result.Export())
		}
		return c.vm.ToValue(results)
	}
}

func (c *Cursor) jsHasNext() func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if err := c.execute(); err != nil {
			panic(c.vm.NewGoError(err))
		}
		// Pre-fetch next document if we haven't yet
		if c.position >= len(c.documents) && !c.exhausted {
			c.fetchNextBatch()
		}
		return c.vm.ToValue(c.position < len(c.documents))
	}
}

func (c *Cursor) jsNext() func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if err := c.execute(); err != nil {
			panic(c.vm.NewGoError(err))
		}
		if c.position >= len(c.documents) && !c.exhausted {
			c.fetchNextBatch()
		}
		if c.position >= len(c.documents) {
			panic(c.vm.NewTypeError("cursor exhausted"))
		}
		doc := c.documents[c.position]
		c.position++
		return convert.GoToJS(c.vm, doc)
	}
}

func (c *Cursor) fetchNextBatch() {
	if c.cursor == nil || c.exhausted {
		return
	}
	ctx := context.Background()
	batch := 0
	batchSize := defaultBatchSize
	if c.batchSizeVal != nil {
		batchSize = int(*c.batchSizeVal)
	}
	for batch < batchSize && c.cursor.Next(ctx) {
		var doc bson.D
		if err := c.cursor.Decode(&doc); err != nil {
			break
		}
		c.documents = append(c.documents, doc)
		batch++
	}
	if batch == 0 {
		c.exhausted = true
	}
}

func (c *Cursor) jsCount() func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		count, err := c.collection.CountDocuments(ctx, c.filter)
		if err != nil {
			panic(c.vm.NewGoError(err))
		}
		return c.vm.ToValue(count)
	}
}

func (c *Cursor) jsItCount() func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if err := c.execute(); err != nil {
			panic(c.vm.NewGoError(err))
		}
		ctx := context.Background()
		count := 0
		for c.cursor.Next(ctx) {
			count++
		}
		return c.vm.ToValue(count)
	}
}

func (c *Cursor) jsClose() func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		if c.cursor != nil {
			c.cursor.Close(context.Background())
		}
		return goja.Undefined()
	}
}

func (c *Cursor) jsExplain() func(call goja.FunctionCall) goja.Value {
	return func(call goja.FunctionCall) goja.Value {
		verbosity := "queryPlanner"
		if len(call.Arguments) > 0 {
			verbosity = call.Arguments[0].String()
		}

		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		cmd := bson.D{
			{Key: "explain", Value: bson.D{
				{Key: "find", Value: c.collection.Name()},
				{Key: "filter", Value: c.filter},
			}},
			{Key: "verbosity", Value: verbosity},
		}

		if c.sortVal != nil {
			for i, elem := range cmd {
				if elem.Key == "explain" {
					if inner, ok := elem.Value.(bson.D); ok {
						inner = append(inner, bson.E{Key: "sort", Value: c.sortVal})
						cmd[i].Value = inner
					}
				}
			}
		}

		var result bson.D
		err := c.collection.Database().RunCommand(ctx, cmd).Decode(&result)
		if err != nil {
			panic(c.vm.NewGoError(err))
		}
		return convert.GoToJS(c.vm, result)
	}
}

// PrintBatch prints the next batch of documents and returns whether there are more.
func (c *Cursor) PrintBatch() (bool, error) {
	if err := c.execute(); err != nil {
		return false, err
	}

	if c.position >= len(c.documents) && !c.exhausted {
		c.fetchNextBatch()
	}

	printed := 0
	for c.position < len(c.documents) && printed < defaultBatchSize {
		doc := c.documents[c.position]
		fmt.Println(output.FormatValue(doc, 0))
		c.position++
		printed++
	}

	// Check if there are more
	if c.position >= len(c.documents) && !c.exhausted {
		c.fetchNextBatch()
	}

	hasMore := c.position < len(c.documents) || !c.exhausted
	if hasMore && printed > 0 {
		fmt.Println("Type \"it\" for more")
	}
	return hasMore, nil
}
