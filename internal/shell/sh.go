package shell

import (
	"context"
	"fmt"
	"time"

	"github.com/adaptive-scale/go-mongosh/internal/convert"
	"github.com/adaptive-scale/go-mongosh/internal/mongoclient"
	"github.com/dop251/goja"
	"go.mongodb.org/mongo-driver/v2/bson"
)

// NewSHObject creates the `sh` global object for sharding commands.
func NewSHObject(vm *goja.Runtime, client *mongoclient.Client) *goja.Object {
	s := &shObject{vm: vm, client: client}
	obj := vm.NewObject()

	obj.Set("status", s.status)
	obj.Set("addShard", s.addShard)
	obj.Set("removeShard", s.removeShard)
	obj.Set("enableSharding", s.enableSharding)
	obj.Set("shardCollection", s.shardCollection)
	obj.Set("moveChunk", s.moveChunk)
	obj.Set("getBalancerState", s.getBalancerState)
	obj.Set("isBalancerRunning", s.isBalancerRunning)
	obj.Set("startBalancer", s.startBalancer)
	obj.Set("stopBalancer", s.stopBalancer)
	obj.Set("help", s.help)

	return obj
}

type shObject struct {
	vm     *goja.Runtime
	client *mongoclient.Client
}

func (s *shObject) runAdminCmd(cmd interface{}) interface{} {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var result bson.D
	err := s.client.Inner().Database("admin").RunCommand(ctx, cmd).Decode(&result)
	if err != nil {
		panic(s.vm.NewGoError(fmt.Errorf("command failed: %w", err)))
	}
	return result
}

func (s *shObject) status() interface{} {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	// Get sharding status by reading from config database
	var result bson.D

	// Try listShards first
	err := s.client.Inner().Database("admin").RunCommand(ctx, bson.D{{Key: "listShards", Value: 1}}).Decode(&result)
	if err != nil {
		// Not a sharded cluster
		return map[string]interface{}{
			"ok":    0,
			"errmsg": "not a sharded cluster",
		}
	}

	return result
}

func (s *shObject) addShard(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(s.vm.NewTypeError("addShard requires a shard URL"))
	}
	url := call.Arguments[0].String()
	result := s.runAdminCmd(bson.D{{Key: "addShard", Value: url}})
	return convert.GoToJS(s.vm, result)
}

func (s *shObject) removeShard(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(s.vm.NewTypeError("removeShard requires a shard name"))
	}
	name := call.Arguments[0].String()
	result := s.runAdminCmd(bson.D{{Key: "removeShard", Value: name}})
	return convert.GoToJS(s.vm, result)
}

func (s *shObject) enableSharding(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(s.vm.NewTypeError("enableSharding requires a database name"))
	}
	dbName := call.Arguments[0].String()
	result := s.runAdminCmd(bson.D{{Key: "enableSharding", Value: dbName}})
	return convert.GoToJS(s.vm, result)
}

func (s *shObject) shardCollection(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(s.vm.NewTypeError("shardCollection requires namespace and key"))
	}
	ns := call.Arguments[0].String()
	key := convert.JSToGo(s.vm, call.Arguments[1])
	result := s.runAdminCmd(bson.D{
		{Key: "shardCollection", Value: ns},
		{Key: "key", Value: key},
	})
	return convert.GoToJS(s.vm, result)
}

func (s *shObject) moveChunk(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 3 {
		panic(s.vm.NewTypeError("moveChunk requires namespace, query, and destination"))
	}
	ns := call.Arguments[0].String()
	query := convert.JSToGo(s.vm, call.Arguments[1])
	dest := call.Arguments[2].String()
	result := s.runAdminCmd(bson.D{
		{Key: "moveChunk", Value: ns},
		{Key: "find", Value: query},
		{Key: "to", Value: dest},
	})
	return convert.GoToJS(s.vm, result)
}

func (s *shObject) getBalancerState() interface{} {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	var result bson.D
	err := s.client.Inner().Database("config").Collection("settings").FindOne(ctx, bson.D{{Key: "_id", Value: "balancer"}}).Decode(&result)
	if err != nil {
		return map[string]interface{}{"enabled": true} // default is enabled
	}

	for _, elem := range result {
		if elem.Key == "stopped" {
			if stopped, ok := elem.Value.(bool); ok {
				return map[string]interface{}{"enabled": !stopped}
			}
		}
	}
	return map[string]interface{}{"enabled": true}
}

func (s *shObject) isBalancerRunning() interface{} {
	return s.runAdminCmd(bson.D{{Key: "balancerStatus", Value: 1}})
}

func (s *shObject) startBalancer() interface{} {
	return s.runAdminCmd(bson.D{{Key: "balancerStart", Value: 1}})
}

func (s *shObject) stopBalancer() interface{} {
	return s.runAdminCmd(bson.D{{Key: "balancerStop", Value: 1}})
}

func (s *shObject) help() string {
	return `Sharding Methods:
  sh.status()                        Sharding status
  sh.addShard(url)                   Add a shard
  sh.removeShard(name)               Remove a shard
  sh.enableSharding(dbName)          Enable sharding on a database
  sh.shardCollection(ns, key)        Shard a collection
  sh.moveChunk(ns, query, dest)      Move a chunk
  sh.getBalancerState()              Get balancer state
  sh.isBalancerRunning()             Check if balancer is running
  sh.startBalancer()                 Start the balancer
  sh.stopBalancer()                  Stop the balancer`
}
