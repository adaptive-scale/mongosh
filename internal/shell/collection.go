package shell

import (
	"context"
	"fmt"
	"time"

	"github.com/adaptive-scale/go-mongosh/internal/convert"
	"github.com/adaptive-scale/go-mongosh/internal/mongoclient"
	"github.com/adaptive-scale/go-mongosh/internal/output"
	"github.com/dop251/goja"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// CollectionObject wraps a mongo.Collection and exposes mongosh methods.
type CollectionObject struct {
	vm     *goja.Runtime
	client *mongoclient.Client
	name   string
}

// NewCollectionObject creates a JS object representing a MongoDB collection.
func NewCollectionObject(vm *goja.Runtime, client *mongoclient.Client, name string) goja.Value {
	c := &CollectionObject{vm: vm, client: client, name: name}
	obj := vm.NewObject()

	// Query
	obj.Set("find", c.find)
	obj.Set("findOne", c.findOne)

	// Insert
	obj.Set("insertOne", c.insertOne)
	obj.Set("insertMany", c.insertMany)

	// Update
	obj.Set("updateOne", c.updateOne)
	obj.Set("updateMany", c.updateMany)
	obj.Set("replaceOne", c.replaceOne)

	// Delete
	obj.Set("deleteOne", c.deleteOne)
	obj.Set("deleteMany", c.deleteMany)

	// FindAndModify variants
	obj.Set("findOneAndUpdate", c.findOneAndUpdate)
	obj.Set("findOneAndReplace", c.findOneAndReplace)
	obj.Set("findOneAndDelete", c.findOneAndDelete)
	obj.Set("findAndModify", c.findAndModify)

	// Aggregation
	obj.Set("aggregate", c.aggregate)
	obj.Set("countDocuments", c.countDocuments)
	obj.Set("estimatedDocumentCount", c.estimatedDocumentCount)
	obj.Set("distinct", c.distinct)

	// Indexes
	obj.Set("createIndex", c.createIndex)
	obj.Set("createIndexes", c.createIndexes)
	obj.Set("dropIndex", c.dropIndex)
	obj.Set("dropIndexes", c.dropIndexes)
	obj.Set("getIndexes", c.getIndexes)

	// Collection management
	obj.Set("drop", c.drop)
	obj.Set("renameCollection", c.renameCollection)
	obj.Set("stats", c.stats)
	obj.Set("validate", c.validate)
	obj.Set("isCapped", c.isCapped)

	// Bulk
	obj.Set("bulkWrite", c.bulkWrite)

	// Explain
	obj.Set("explain", c.explain)

	// Identity
	obj.Set("getName", func() string { return name })
	obj.Set("toString", func() string { return fmt.Sprintf("%s.%s", client.CurrentDBName(), name) })

	// Help
	obj.Set("help", c.help)

	return obj
}

func (c *CollectionObject) coll() *mongo.Collection {
	return c.client.CurrentDB().Collection(c.name)
}

func (c *CollectionObject) defaultCtx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 30*time.Second)
}

// --- Query ---

func (c *CollectionObject) find(call goja.FunctionCall) goja.Value {
	var filter interface{} = bson.D{}
	if len(call.Arguments) > 0 && !goja.IsUndefined(call.Arguments[0]) && !goja.IsNull(call.Arguments[0]) {
		filter = convert.JSToGo(c.vm, call.Arguments[0])
	}

	cursor := NewCursor(c.vm, c.coll(), filter)

	// Handle projection as second argument
	if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) && !goja.IsNull(call.Arguments[1]) {
		cursor.projectionVal = convert.JSToGo(c.vm, call.Arguments[1])
	}

	return cursor.ToJSObject()
}

func (c *CollectionObject) findOne(call goja.FunctionCall) goja.Value {
	ctx, cancel := c.defaultCtx()
	defer cancel()

	var filter interface{} = bson.D{}
	if len(call.Arguments) > 0 && !goja.IsUndefined(call.Arguments[0]) && !goja.IsNull(call.Arguments[0]) {
		filter = convert.JSToGo(c.vm, call.Arguments[0])
	}

	opts := options.FindOne()
	if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) && !goja.IsNull(call.Arguments[1]) {
		opts.SetProjection(convert.JSToGo(c.vm, call.Arguments[1]))
	}

	var result bson.D
	err := c.coll().FindOne(ctx, filter, opts).Decode(&result)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return goja.Null()
		}
		panic(c.vm.NewGoError(err))
	}
	return convert.GoToJS(c.vm, result)
}

// --- Insert ---

func (c *CollectionObject) insertOne(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("insertOne requires a document"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	doc := convert.JSToGo(c.vm, call.Arguments[0])
	result, err := c.coll().InsertOne(ctx, doc)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}

	obj := c.vm.NewObject()
	obj.Set("acknowledged", true)
	obj.Set("insertedId", convert.GoToJS(c.vm, result.InsertedID))
	return obj
}

func (c *CollectionObject) insertMany(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("insertMany requires an array of documents"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	arr := call.Arguments[0].Export()
	docs, ok := arr.([]interface{})
	if !ok {
		panic(c.vm.NewTypeError("insertMany requires an array of documents"))
	}

	// Convert each doc via JS
	jsArr := call.Arguments[0].ToObject(c.vm)
	bsonDocs := make([]interface{}, len(docs))
	for i := range docs {
		elem := jsArr.Get(fmt.Sprintf("%d", i))
		bsonDocs[i] = convert.JSToGo(c.vm, elem)
	}

	result, err := c.coll().InsertMany(ctx, bsonDocs)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}

	ids := make([]interface{}, len(result.InsertedIDs))
	for i, id := range result.InsertedIDs {
		ids[i] = convert.GoToJS(c.vm, id).Export()
	}

	obj := c.vm.NewObject()
	obj.Set("acknowledged", true)
	obj.Set("insertedIds", ids)
	return obj
}

// --- Update ---

func (c *CollectionObject) updateOne(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(c.vm.NewTypeError("updateOne requires filter and update"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	filter := convert.JSToGo(c.vm, call.Arguments[0])
	update := convert.JSToGo(c.vm, call.Arguments[1])

	opts := options.UpdateOne()
	if len(call.Arguments) > 2 && !goja.IsUndefined(call.Arguments[2]) {
		optsMap := call.Arguments[2].Export()
		if m, ok := optsMap.(map[string]interface{}); ok {
			if upsert, ok := m["upsert"].(bool); ok {
				opts.SetUpsert(upsert)
			}
		}
	}

	result, err := c.coll().UpdateOne(ctx, filter, update, opts)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}
	return c.updateResultToJS(result)
}

func (c *CollectionObject) updateMany(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(c.vm.NewTypeError("updateMany requires filter and update"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	filter := convert.JSToGo(c.vm, call.Arguments[0])
	update := convert.JSToGo(c.vm, call.Arguments[1])

	opts := options.UpdateMany()
	if len(call.Arguments) > 2 && !goja.IsUndefined(call.Arguments[2]) {
		optsMap := call.Arguments[2].Export()
		if m, ok := optsMap.(map[string]interface{}); ok {
			if upsert, ok := m["upsert"].(bool); ok {
				opts.SetUpsert(upsert)
			}
		}
	}

	result, err := c.coll().UpdateMany(ctx, filter, update, opts)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}
	return c.updateResultToJS(result)
}

func (c *CollectionObject) replaceOne(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(c.vm.NewTypeError("replaceOne requires filter and replacement"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	filter := convert.JSToGo(c.vm, call.Arguments[0])
	replacement := convert.JSToGo(c.vm, call.Arguments[1])

	opts := options.Replace()
	if len(call.Arguments) > 2 && !goja.IsUndefined(call.Arguments[2]) {
		optsMap := call.Arguments[2].Export()
		if m, ok := optsMap.(map[string]interface{}); ok {
			if upsert, ok := m["upsert"].(bool); ok {
				opts.SetUpsert(upsert)
			}
		}
	}

	result, err := c.coll().ReplaceOne(ctx, filter, replacement, opts)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}
	return c.updateResultToJS(result)
}

func (c *CollectionObject) updateResultToJS(result *mongo.UpdateResult) goja.Value {
	obj := c.vm.NewObject()
	obj.Set("acknowledged", true)
	obj.Set("matchedCount", result.MatchedCount)
	obj.Set("modifiedCount", result.ModifiedCount)
	obj.Set("upsertedCount", result.UpsertedCount)
	if result.UpsertedID != nil {
		obj.Set("upsertedId", convert.GoToJS(c.vm, result.UpsertedID))
	}
	return obj
}

// --- Delete ---

func (c *CollectionObject) deleteOne(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("deleteOne requires a filter"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	filter := convert.JSToGo(c.vm, call.Arguments[0])
	result, err := c.coll().DeleteOne(ctx, filter)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}

	obj := c.vm.NewObject()
	obj.Set("acknowledged", true)
	obj.Set("deletedCount", result.DeletedCount)
	return obj
}

func (c *CollectionObject) deleteMany(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("deleteMany requires a filter"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	filter := convert.JSToGo(c.vm, call.Arguments[0])
	result, err := c.coll().DeleteMany(ctx, filter)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}

	obj := c.vm.NewObject()
	obj.Set("acknowledged", true)
	obj.Set("deletedCount", result.DeletedCount)
	return obj
}

// --- FindAndModify variants ---

func (c *CollectionObject) findOneAndUpdate(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(c.vm.NewTypeError("findOneAndUpdate requires filter and update"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	filter := convert.JSToGo(c.vm, call.Arguments[0])
	update := convert.JSToGo(c.vm, call.Arguments[1])

	opts := options.FindOneAndUpdate()
	if len(call.Arguments) > 2 && !goja.IsUndefined(call.Arguments[2]) {
		optsMap := call.Arguments[2].Export()
		if m, ok := optsMap.(map[string]interface{}); ok {
			if rd, ok := m["returnDocument"].(string); ok {
				if rd == "after" {
					opts.SetReturnDocument(options.After)
				}
			}
			if upsert, ok := m["upsert"].(bool); ok {
				opts.SetUpsert(upsert)
			}
			if proj, ok := m["projection"]; ok {
				opts.SetProjection(proj)
			}
			if sort, ok := m["sort"]; ok {
				opts.SetSort(sort)
			}
		}
	}

	var result bson.D
	err := c.coll().FindOneAndUpdate(ctx, filter, update, opts).Decode(&result)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return goja.Null()
		}
		panic(c.vm.NewGoError(err))
	}
	return convert.GoToJS(c.vm, result)
}

func (c *CollectionObject) findOneAndReplace(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(c.vm.NewTypeError("findOneAndReplace requires filter and replacement"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	filter := convert.JSToGo(c.vm, call.Arguments[0])
	replacement := convert.JSToGo(c.vm, call.Arguments[1])

	opts := options.FindOneAndReplace()
	if len(call.Arguments) > 2 && !goja.IsUndefined(call.Arguments[2]) {
		optsMap := call.Arguments[2].Export()
		if m, ok := optsMap.(map[string]interface{}); ok {
			if rd, ok := m["returnDocument"].(string); ok {
				if rd == "after" {
					opts.SetReturnDocument(options.After)
				}
			}
			if upsert, ok := m["upsert"].(bool); ok {
				opts.SetUpsert(upsert)
			}
		}
	}

	var result bson.D
	err := c.coll().FindOneAndReplace(ctx, filter, replacement, opts).Decode(&result)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return goja.Null()
		}
		panic(c.vm.NewGoError(err))
	}
	return convert.GoToJS(c.vm, result)
}

func (c *CollectionObject) findOneAndDelete(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("findOneAndDelete requires a filter"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	filter := convert.JSToGo(c.vm, call.Arguments[0])

	opts := options.FindOneAndDelete()
	if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
		optsMap := call.Arguments[1].Export()
		if m, ok := optsMap.(map[string]interface{}); ok {
			if sort, ok := m["sort"]; ok {
				opts.SetSort(sort)
			}
			if proj, ok := m["projection"]; ok {
				opts.SetProjection(proj)
			}
		}
	}

	var result bson.D
	err := c.coll().FindOneAndDelete(ctx, filter, opts).Decode(&result)
	if err != nil {
		if err == mongo.ErrNoDocuments {
			return goja.Null()
		}
		panic(c.vm.NewGoError(err))
	}
	return convert.GoToJS(c.vm, result)
}

func (c *CollectionObject) findAndModify(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("findAndModify requires a document"))
	}

	doc := convert.JSToGo(c.vm, call.Arguments[0])
	ctx, cancel := c.defaultCtx()
	defer cancel()

	cmd := bson.D{{Key: "findAndModify", Value: c.name}}
	if d, ok := doc.(bson.D); ok {
		cmd = append(cmd, d...)
	}

	var result bson.D
	err := c.client.CurrentDB().RunCommand(ctx, cmd).Decode(&result)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}
	return convert.GoToJS(c.vm, result)
}

// --- Aggregation ---

func (c *CollectionObject) aggregate(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("aggregate requires a pipeline"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	pipeline := convert.JSToGo(c.vm, call.Arguments[0])

	opts := options.Aggregate()
	if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
		optsMap := call.Arguments[1].Export()
		if m, ok := optsMap.(map[string]interface{}); ok {
			if allowDisk, ok := m["allowDiskUse"].(bool); ok {
				opts.SetAllowDiskUse(allowDisk)
			}
		}
	}

	cursor, err := c.coll().Aggregate(ctx, pipeline, opts)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}

	var results []bson.D
	if err := cursor.All(ctx, &results); err != nil {
		panic(c.vm.NewGoError(err))
	}

	// Return as a cursor-like object for consistency
	aggCursor := &AggCursor{vm: c.vm, results: results}
	return aggCursor.ToJSObject()
}

func (c *CollectionObject) countDocuments(call goja.FunctionCall) goja.Value {
	ctx, cancel := c.defaultCtx()
	defer cancel()

	var filter interface{} = bson.D{}
	if len(call.Arguments) > 0 && !goja.IsUndefined(call.Arguments[0]) && !goja.IsNull(call.Arguments[0]) {
		filter = convert.JSToGo(c.vm, call.Arguments[0])
	}

	count, err := c.coll().CountDocuments(ctx, filter)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}
	return c.vm.ToValue(count)
}

func (c *CollectionObject) estimatedDocumentCount(call goja.FunctionCall) goja.Value {
	ctx, cancel := c.defaultCtx()
	defer cancel()

	count, err := c.coll().EstimatedDocumentCount(ctx)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}
	return c.vm.ToValue(count)
}

func (c *CollectionObject) distinct(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("distinct requires a field name"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	field := call.Arguments[0].String()
	var filter interface{} = bson.D{}
	if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) && !goja.IsNull(call.Arguments[1]) {
		filter = convert.JSToGo(c.vm, call.Arguments[1])
	}

	// Use runCommand for distinct since the driver's Distinct API changed in v2
	cmd := bson.D{
		{Key: "distinct", Value: c.name},
		{Key: "key", Value: field},
		{Key: "query", Value: filter},
	}

	var result bson.D
	err := c.client.CurrentDB().RunCommand(ctx, cmd).Decode(&result)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}

	// Extract the "values" field
	for _, elem := range result {
		if elem.Key == "values" {
			return convert.GoToJS(c.vm, elem.Value)
		}
	}
	return c.vm.ToValue([]interface{}{})
}

// --- Indexes ---

func (c *CollectionObject) createIndex(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("createIndex requires key specification"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	keys := convert.JSToGo(c.vm, call.Arguments[0])
	model := mongo.IndexModel{Keys: keys}

	if len(call.Arguments) > 1 && !goja.IsUndefined(call.Arguments[1]) {
		optsMap := call.Arguments[1].Export()
		if m, ok := optsMap.(map[string]interface{}); ok {
			idxOpts := options.Index()
			if name, ok := m["name"].(string); ok {
				idxOpts.SetName(name)
			}
			if unique, ok := m["unique"].(bool); ok {
				idxOpts.SetUnique(unique)
			}
			if sparse, ok := m["sparse"].(bool); ok {
				idxOpts.SetSparse(sparse)
			}
			if ttl, ok := m["expireAfterSeconds"].(float64); ok {
				idxOpts.SetExpireAfterSeconds(int32(ttl))
			}
			if ttl, ok := m["expireAfterSeconds"].(int64); ok {
				idxOpts.SetExpireAfterSeconds(int32(ttl))
			}
			model.Options = idxOpts
		}
	}

	name, err := c.coll().Indexes().CreateOne(ctx, model)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}
	return c.vm.ToValue(name)
}

func (c *CollectionObject) createIndexes(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("createIndexes requires an array of index specifications"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	arr := call.Arguments[0].Export()
	specs, ok := arr.([]interface{})
	if !ok {
		panic(c.vm.NewTypeError("createIndexes requires an array"))
	}

	jsArr := call.Arguments[0].ToObject(c.vm)
	var models []mongo.IndexModel
	for i := range specs {
		elem := jsArr.Get(fmt.Sprintf("%d", i))
		specObj := elem.ToObject(c.vm)

		keysVal := specObj.Get("key")
		if keysVal == nil || goja.IsUndefined(keysVal) {
			panic(c.vm.NewTypeError("each index spec must have a 'key' field"))
		}

		model := mongo.IndexModel{
			Keys: convert.JSToGo(c.vm, keysVal),
		}

		idxOpts := options.Index()
		if nameVal := specObj.Get("name"); nameVal != nil && !goja.IsUndefined(nameVal) {
			idxOpts.SetName(nameVal.String())
		}
		if uniqueVal := specObj.Get("unique"); uniqueVal != nil && !goja.IsUndefined(uniqueVal) {
			idxOpts.SetUnique(uniqueVal.ToBoolean())
		}
		model.Options = idxOpts

		models = append(models, model)
	}

	names, err := c.coll().Indexes().CreateMany(ctx, models)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}

	result := make([]interface{}, len(names))
	for i, n := range names {
		result[i] = n
	}
	return c.vm.ToValue(result)
}

func (c *CollectionObject) dropIndex(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("dropIndex requires an index name or key spec"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	arg := call.Arguments[0]
	if arg.ExportType().Kind().String() == "string" {
		// Drop by name
		err := c.coll().Indexes().DropOne(ctx, arg.String())
		if err != nil {
			panic(c.vm.NewGoError(err))
		}
	} else {
		// Drop by key specification - use runCommand fallback
		keys := convert.JSToGo(c.vm, arg)
		cmd := bson.D{
			{Key: "dropIndexes", Value: c.name},
			{Key: "index", Value: keys},
		}
		var result bson.D
		err := c.client.CurrentDB().RunCommand(ctx, cmd).Decode(&result)
		if err != nil {
			panic(c.vm.NewGoError(err))
		}
	}

	obj := c.vm.NewObject()
	obj.Set("ok", 1)
	return obj
}

func (c *CollectionObject) dropIndexes(call goja.FunctionCall) goja.Value {
	ctx, cancel := c.defaultCtx()
	defer cancel()

	err := c.coll().Indexes().DropAll(ctx)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}

	obj := c.vm.NewObject()
	obj.Set("ok", 1)
	return obj
}

func (c *CollectionObject) getIndexes(call goja.FunctionCall) goja.Value {
	ctx, cancel := c.defaultCtx()
	defer cancel()

	cursor, err := c.coll().Indexes().List(ctx)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}

	var results []bson.D
	if err := cursor.All(ctx, &results); err != nil {
		panic(c.vm.NewGoError(err))
	}

	arr := make([]interface{}, len(results))
	for i, doc := range results {
		arr[i] = convert.GoToJS(c.vm, doc).Export()
	}
	return c.vm.ToValue(arr)
}

// --- Collection management ---

func (c *CollectionObject) drop(call goja.FunctionCall) goja.Value {
	ctx, cancel := c.defaultCtx()
	defer cancel()

	err := c.coll().Drop(ctx)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}
	return c.vm.ToValue(true)
}

func (c *CollectionObject) renameCollection(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("renameCollection requires a new name"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	newName := call.Arguments[0].String()
	dbName := c.client.CurrentDBName()

	cmd := bson.D{
		{Key: "renameCollection", Value: fmt.Sprintf("%s.%s", dbName, c.name)},
		{Key: "to", Value: fmt.Sprintf("%s.%s", dbName, newName)},
	}

	var result bson.D
	err := c.client.Inner().Database("admin").RunCommand(ctx, cmd).Decode(&result)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}
	return convert.GoToJS(c.vm, result)
}

func (c *CollectionObject) stats(call goja.FunctionCall) goja.Value {
	ctx, cancel := c.defaultCtx()
	defer cancel()

	cmd := bson.D{{Key: "collStats", Value: c.name}}
	var result bson.D
	err := c.client.CurrentDB().RunCommand(ctx, cmd).Decode(&result)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}
	return convert.GoToJS(c.vm, result)
}

func (c *CollectionObject) validate(call goja.FunctionCall) goja.Value {
	ctx, cancel := c.defaultCtx()
	defer cancel()

	cmd := bson.D{{Key: "validate", Value: c.name}}
	var result bson.D
	err := c.client.CurrentDB().RunCommand(ctx, cmd).Decode(&result)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}
	return convert.GoToJS(c.vm, result)
}

func (c *CollectionObject) isCapped(call goja.FunctionCall) goja.Value {
	ctx, cancel := c.defaultCtx()
	defer cancel()

	cmd := bson.D{{Key: "collStats", Value: c.name}}
	var result bson.D
	err := c.client.CurrentDB().RunCommand(ctx, cmd).Decode(&result)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}

	for _, elem := range result {
		if elem.Key == "capped" {
			return c.vm.ToValue(elem.Value)
		}
	}
	return c.vm.ToValue(false)
}

// --- Bulk ---

func (c *CollectionObject) bulkWrite(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(c.vm.NewTypeError("bulkWrite requires an array of operations"))
	}
	ctx, cancel := c.defaultCtx()
	defer cancel()

	arr := call.Arguments[0].Export()
	ops, ok := arr.([]interface{})
	if !ok {
		panic(c.vm.NewTypeError("bulkWrite requires an array"))
	}

	jsArr := call.Arguments[0].ToObject(c.vm)
	var models []mongo.WriteModel

	for i := range ops {
		elem := jsArr.Get(fmt.Sprintf("%d", i))
		opObj := elem.ToObject(c.vm)

		for _, key := range opObj.Keys() {
			opVal := opObj.Get(key)
			opDoc := opVal.ToObject(c.vm)

			switch key {
			case "insertOne":
				docVal := opDoc.Get("document")
				doc := convert.JSToGo(c.vm, docVal)
				models = append(models, &mongo.InsertOneModel{Document: doc})

			case "updateOne":
				filter := convert.JSToGo(c.vm, opDoc.Get("filter"))
				update := convert.JSToGo(c.vm, opDoc.Get("update"))
				m := &mongo.UpdateOneModel{Filter: filter, Update: update}
				if upsertVal := opDoc.Get("upsert"); upsertVal != nil && !goja.IsUndefined(upsertVal) {
					u := upsertVal.ToBoolean()
					m.Upsert = &u
				}
				models = append(models, m)

			case "updateMany":
				filter := convert.JSToGo(c.vm, opDoc.Get("filter"))
				update := convert.JSToGo(c.vm, opDoc.Get("update"))
				m := &mongo.UpdateManyModel{Filter: filter, Update: update}
				if upsertVal := opDoc.Get("upsert"); upsertVal != nil && !goja.IsUndefined(upsertVal) {
					u := upsertVal.ToBoolean()
					m.Upsert = &u
				}
				models = append(models, m)

			case "replaceOne":
				filter := convert.JSToGo(c.vm, opDoc.Get("filter"))
				replacement := convert.JSToGo(c.vm, opDoc.Get("replacement"))
				m := &mongo.ReplaceOneModel{Filter: filter, Replacement: replacement}
				if upsertVal := opDoc.Get("upsert"); upsertVal != nil && !goja.IsUndefined(upsertVal) {
					u := upsertVal.ToBoolean()
					m.Upsert = &u
				}
				models = append(models, m)

			case "deleteOne":
				filter := convert.JSToGo(c.vm, opDoc.Get("filter"))
				models = append(models, &mongo.DeleteOneModel{Filter: filter})

			case "deleteMany":
				filter := convert.JSToGo(c.vm, opDoc.Get("filter"))
				models = append(models, &mongo.DeleteManyModel{Filter: filter})
			}
		}
	}

	result, err := c.coll().BulkWrite(ctx, models)
	if err != nil {
		panic(c.vm.NewGoError(err))
	}

	obj := c.vm.NewObject()
	obj.Set("acknowledged", true)
	obj.Set("insertedCount", result.InsertedCount)
	obj.Set("matchedCount", result.MatchedCount)
	obj.Set("modifiedCount", result.ModifiedCount)
	obj.Set("deletedCount", result.DeletedCount)
	obj.Set("upsertedCount", result.UpsertedCount)
	return obj
}

// --- Explain ---

func (c *CollectionObject) explain(call goja.FunctionCall) goja.Value {
	verbosity := "queryPlanner"
	if len(call.Arguments) > 0 {
		verbosity = call.Arguments[0].String()
	}

	// Return a proxy collection that wraps commands in explain
	proxy := c.vm.NewObject()

	proxy.Set("find", func(fcall goja.FunctionCall) goja.Value {
		var filter interface{} = bson.D{}
		if len(fcall.Arguments) > 0 && !goja.IsUndefined(fcall.Arguments[0]) {
			filter = convert.JSToGo(c.vm, fcall.Arguments[0])
		}

		ctx, cancel := c.defaultCtx()
		defer cancel()

		cmd := bson.D{
			{Key: "explain", Value: bson.D{
				{Key: "find", Value: c.name},
				{Key: "filter", Value: filter},
			}},
			{Key: "verbosity", Value: verbosity},
		}

		var result bson.D
		err := c.client.CurrentDB().RunCommand(ctx, cmd).Decode(&result)
		if err != nil {
			panic(c.vm.NewGoError(err))
		}
		return convert.GoToJS(c.vm, result)
	})

	proxy.Set("aggregate", func(fcall goja.FunctionCall) goja.Value {
		if len(fcall.Arguments) < 1 {
			panic(c.vm.NewTypeError("aggregate requires a pipeline"))
		}
		pipeline := convert.JSToGo(c.vm, fcall.Arguments[0])

		ctx, cancel := c.defaultCtx()
		defer cancel()

		cmd := bson.D{
			{Key: "explain", Value: bson.D{
				{Key: "aggregate", Value: c.name},
				{Key: "pipeline", Value: pipeline},
				{Key: "cursor", Value: bson.D{}},
			}},
			{Key: "verbosity", Value: verbosity},
		}

		var result bson.D
		err := c.client.CurrentDB().RunCommand(ctx, cmd).Decode(&result)
		if err != nil {
			panic(c.vm.NewGoError(err))
		}
		return convert.GoToJS(c.vm, result)
	})

	return proxy
}

// --- Help ---

func (c *CollectionObject) help() string {
	return `Collection Methods:
  db.coll.find(filter, proj)           Find documents
  db.coll.findOne(filter, proj)        Find one document
  db.coll.insertOne(doc)               Insert a document
  db.coll.insertMany([docs])           Insert multiple documents
  db.coll.updateOne(filter, update)    Update one document
  db.coll.updateMany(filter, update)   Update multiple documents
  db.coll.replaceOne(filter, doc)      Replace one document
  db.coll.deleteOne(filter)            Delete one document
  db.coll.deleteMany(filter)           Delete multiple documents
  db.coll.findOneAndUpdate(f, u, o)    Find and update
  db.coll.findOneAndReplace(f, r, o)   Find and replace
  db.coll.findOneAndDelete(f, o)       Find and delete
  db.coll.aggregate([pipeline])        Run aggregation
  db.coll.countDocuments(filter)       Count documents
  db.coll.estimatedDocumentCount()     Estimated count
  db.coll.distinct(field, filter)      Distinct values
  db.coll.createIndex(keys, opts)      Create an index
  db.coll.getIndexes()                 List indexes
  db.coll.dropIndex(name)              Drop an index
  db.coll.dropIndexes()                Drop all indexes
  db.coll.drop()                       Drop collection
  db.coll.renameCollection(newName)    Rename collection
  db.coll.stats()                      Collection statistics
  db.coll.validate()                   Validate collection
  db.coll.bulkWrite([ops])             Bulk write operations
  db.coll.explain(verbosity)           Explain operations`
}

// AggCursor wraps aggregation results for display.
type AggCursor struct {
	vm      *goja.Runtime
	results []bson.D
	pos     int
}

func (a *AggCursor) ToJSObject() goja.Value {
	obj := a.vm.NewObject()
	obj.Set("_isCursor", true)
	obj.Set("toArray", a.toArray)
	obj.Set("forEach", a.forEach)
	obj.Set("hasNext", a.hasNext)
	obj.Set("next", a.next)
	obj.Set("pretty", func() goja.Value { return obj })
	obj.Set("sort", func() goja.Value { return obj })
	obj.Set("limit", func() goja.Value { return obj })
	obj.Set("skip", func() goja.Value { return obj })
	return obj
}

func (a *AggCursor) toArray() interface{} {
	arr := make([]interface{}, len(a.results))
	for i, doc := range a.results {
		arr[i] = convert.GoToJS(a.vm, doc).Export()
	}
	return arr
}

func (a *AggCursor) forEach(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(a.vm.NewTypeError("forEach requires a callback function"))
	}
	fn, ok := goja.AssertFunction(call.Arguments[0])
	if !ok {
		panic(a.vm.NewTypeError("forEach requires a callback function"))
	}
	for _, doc := range a.results {
		jsDoc := convert.GoToJS(a.vm, doc)
		_, err := fn(goja.Undefined(), jsDoc)
		if err != nil {
			panic(err)
		}
	}
	return goja.Undefined()
}

func (a *AggCursor) hasNext() bool {
	return a.pos < len(a.results)
}

func (a *AggCursor) next() goja.Value {
	if a.pos >= len(a.results) {
		panic(a.vm.NewTypeError("cursor exhausted"))
	}
	doc := a.results[a.pos]
	a.pos++
	return convert.GoToJS(a.vm, doc)
}

// PrintAggBatch prints the aggregation results batch-style.
func (a *AggCursor) PrintAggBatch() {
	for i := a.pos; i < len(a.results) && i < a.pos+defaultBatchSize; i++ {
		fmt.Println(output.FormatValue(a.results[i], 0))
	}
	if a.pos+defaultBatchSize < len(a.results) {
		fmt.Println("Type \"it\" for more")
	}
	a.pos += defaultBatchSize
}
