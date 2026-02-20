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

// NewRSObject creates the `rs` global object for replica set commands.
func NewRSObject(vm *goja.Runtime, client *mongoclient.Client) *goja.Object {
	rs := &rsObject{vm: vm, client: client}
	obj := vm.NewObject()

	obj.Set("status", rs.status)
	obj.Set("conf", rs.conf)
	obj.Set("config", rs.conf)
	obj.Set("initiate", rs.initiate)
	obj.Set("reconfig", rs.reconfig)
	obj.Set("add", rs.add)
	obj.Set("remove", rs.remove)
	obj.Set("stepDown", rs.stepDown)
	obj.Set("freeze", rs.freeze)
	obj.Set("syncFrom", rs.syncFrom)
	obj.Set("secondaryOk", rs.secondaryOk)
	obj.Set("slaveOk", rs.secondaryOk)
	obj.Set("printReplicationInfo", rs.printReplicationInfo)
	obj.Set("printSecondaryReplicationInfo", rs.printSecondaryReplicationInfo)
	obj.Set("help", rs.help)

	return obj
}

type rsObject struct {
	vm     *goja.Runtime
	client *mongoclient.Client
}

func (r *rsObject) runAdminCmd(cmd interface{}) interface{} {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var result bson.D
	err := r.client.Inner().Database("admin").RunCommand(ctx, cmd).Decode(&result)
	if err != nil {
		panic(r.vm.NewGoError(fmt.Errorf("command failed: %w", err)))
	}
	return result
}

func (r *rsObject) status() interface{} {
	return r.runAdminCmd(bson.D{{Key: "replSetGetStatus", Value: 1}})
}

func (r *rsObject) conf() interface{} {
	result := r.runAdminCmd(bson.D{{Key: "replSetGetConfig", Value: 1}})
	if doc, ok := result.(bson.D); ok {
		for _, elem := range doc {
			if elem.Key == "config" {
				return elem.Value
			}
		}
	}
	return result
}

func (r *rsObject) initiate(call goja.FunctionCall) goja.Value {
	cmd := bson.D{{Key: "replSetInitiate", Value: 1}}
	if len(call.Arguments) > 0 && !goja.IsUndefined(call.Arguments[0]) && !goja.IsNull(call.Arguments[0]) {
		config := convert.JSToGo(r.vm, call.Arguments[0])
		cmd = bson.D{{Key: "replSetInitiate", Value: config}}
	}
	result := r.runAdminCmd(cmd)
	return convert.GoToJS(r.vm, result)
}

func (r *rsObject) reconfig(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(r.vm.NewTypeError("reconfig requires a configuration document"))
	}
	config := convert.JSToGo(r.vm, call.Arguments[0])
	cmd := bson.D{{Key: "replSetReconfig", Value: config}}
	result := r.runAdminCmd(cmd)
	return convert.GoToJS(r.vm, result)
}

func (r *rsObject) add(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(r.vm.NewTypeError("add requires a host string or member config"))
	}

	// Get current config
	configResult := r.runAdminCmd(bson.D{{Key: "replSetGetConfig", Value: 1}})
	configDoc, ok := configResult.(bson.D)
	if !ok {
		panic(r.vm.NewTypeError("failed to get replica set config"))
	}

	var config bson.D
	for _, elem := range configDoc {
		if elem.Key == "config" {
			config, ok = elem.Value.(bson.D)
			if !ok {
				panic(r.vm.NewTypeError("invalid config format"))
			}
			break
		}
	}

	// Find max _id and members array
	var members bson.A
	var maxID int32
	var versionIdx int
	for i, elem := range config {
		if elem.Key == "members" {
			if m, ok := elem.Value.(bson.A); ok {
				members = m
				for _, member := range m {
					if memberDoc, ok := member.(bson.D); ok {
						for _, field := range memberDoc {
							if field.Key == "_id" {
								if id, ok := field.Value.(int32); ok && id > maxID {
									maxID = id
								}
							}
						}
					}
				}
			}
		}
		if elem.Key == "version" {
			versionIdx = i
		}
	}

	newID := maxID + 1
	arg := call.Arguments[0]

	var newMember bson.D
	if arg.ExportType().Kind().String() == "string" {
		newMember = bson.D{
			{Key: "_id", Value: newID},
			{Key: "host", Value: arg.String()},
		}
	} else {
		memberDoc := convert.JSToGo(r.vm, arg)
		if d, ok := memberDoc.(bson.D); ok {
			hasID := false
			for _, elem := range d {
				if elem.Key == "_id" {
					hasID = true
					break
				}
			}
			if !hasID {
				newMember = append(bson.D{{Key: "_id", Value: newID}}, d...)
			} else {
				newMember = d
			}
		}
	}

	members = append(members, newMember)

	// Update members in config
	for i, elem := range config {
		if elem.Key == "members" {
			config[i].Value = members
			break
		}
	}

	// Increment version
	if version, ok := config[versionIdx].Value.(int32); ok {
		config[versionIdx].Value = version + 1
	} else if version, ok := config[versionIdx].Value.(int64); ok {
		config[versionIdx].Value = version + 1
	}

	cmd := bson.D{{Key: "replSetReconfig", Value: config}}
	result := r.runAdminCmd(cmd)
	return convert.GoToJS(r.vm, result)
}

func (r *rsObject) remove(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(r.vm.NewTypeError("remove requires a hostname"))
	}
	hostname := call.Arguments[0].String()

	configResult := r.runAdminCmd(bson.D{{Key: "replSetGetConfig", Value: 1}})
	configDoc, ok := configResult.(bson.D)
	if !ok {
		panic(r.vm.NewTypeError("failed to get config"))
	}

	var config bson.D
	for _, elem := range configDoc {
		if elem.Key == "config" {
			config, _ = elem.Value.(bson.D)
			break
		}
	}

	// Remove member
	for i, elem := range config {
		if elem.Key == "members" {
			if members, ok := elem.Value.(bson.A); ok {
				var newMembers bson.A
				for _, member := range members {
					if memberDoc, ok := member.(bson.D); ok {
						isTarget := false
						for _, field := range memberDoc {
							if field.Key == "host" && field.Value == hostname {
								isTarget = true
								break
							}
						}
						if !isTarget {
							newMembers = append(newMembers, member)
						}
					}
				}
				config[i].Value = newMembers
			}
		}
		if elem.Key == "version" {
			if version, ok := elem.Value.(int32); ok {
				config[i].Value = version + 1
			} else if version, ok := elem.Value.(int64); ok {
				config[i].Value = version + 1
			}
		}
	}

	cmd := bson.D{{Key: "replSetReconfig", Value: config}}
	result := r.runAdminCmd(cmd)
	return convert.GoToJS(r.vm, result)
}

func (r *rsObject) stepDown(call goja.FunctionCall) goja.Value {
	secs := int32(60)
	if len(call.Arguments) > 0 {
		secs = int32(call.Arguments[0].ToInteger())
	}
	result := r.runAdminCmd(bson.D{{Key: "replSetStepDown", Value: secs}})
	return convert.GoToJS(r.vm, result)
}

func (r *rsObject) freeze(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(r.vm.NewTypeError("freeze requires seconds"))
	}
	secs := int32(call.Arguments[0].ToInteger())
	result := r.runAdminCmd(bson.D{{Key: "replSetFreeze", Value: secs}})
	return convert.GoToJS(r.vm, result)
}

func (r *rsObject) syncFrom(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(r.vm.NewTypeError("syncFrom requires a hostname"))
	}
	host := call.Arguments[0].String()
	result := r.runAdminCmd(bson.D{{Key: "replSetSyncFrom", Value: host}})
	return convert.GoToJS(r.vm, result)
}

func (r *rsObject) secondaryOk() string {
	return "This method is deprecated. Use readPref in the connection string instead."
}

func (r *rsObject) printReplicationInfo() interface{} {
	return r.runAdminCmd(bson.D{{Key: "replSetGetStatus", Value: 1}})
}

func (r *rsObject) printSecondaryReplicationInfo() interface{} {
	return r.runAdminCmd(bson.D{{Key: "replSetGetStatus", Value: 1}})
}

func (r *rsObject) help() string {
	return `Replica Set Methods:
  rs.status()                    Replica set status
  rs.conf()                      Replica set configuration
  rs.initiate(config)            Initialize a replica set
  rs.reconfig(config)            Reconfigure replica set
  rs.add(hostOrConfig)           Add a member
  rs.remove(hostname)            Remove a member
  rs.stepDown(secs)              Step down primary
  rs.freeze(secs)                Prevent election for N seconds
  rs.syncFrom(host)              Set sync source`
}
