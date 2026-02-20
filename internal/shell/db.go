package shell

import (
	"context"
	"fmt"
	"time"

	"github.com/adaptive-scale/go-mongosh/internal/convert"
	"github.com/adaptive-scale/go-mongosh/internal/mongoclient"
	"github.com/dop251/goja"
	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// DBObject implements goja.DynamicObject to provide the `db` global.
// Unknown property access returns a Collection for that name.
type DBObject struct {
	vm     *goja.Runtime
	client *mongoclient.Client
}

// NewDBObject creates a new db DynamicObject.
func NewDBObject(vm *goja.Runtime, client *mongoclient.Client) *goja.Object {
	db := &DBObject{vm: vm, client: client}
	return vm.NewDynamicObject(db)
}

// Get intercepts property access on the db object.
func (d *DBObject) Get(key string) goja.Value {
	switch key {
	// Database identity
	case "getName":
		return d.vm.ToValue(d.getName)
	case "toString":
		return d.vm.ToValue(d.getName)

	// Collection management
	case "getCollectionNames":
		return d.vm.ToValue(d.getCollectionNames)
	case "getCollection":
		return d.vm.ToValue(d.getCollection)
	case "createCollection":
		return d.vm.ToValue(d.createCollection)

	// Database operations
	case "dropDatabase":
		return d.vm.ToValue(d.dropDatabase)
	case "stats":
		return d.vm.ToValue(d.dbStats)
	case "version":
		return d.vm.ToValue(d.version)

	// Commands
	case "runCommand":
		return d.vm.ToValue(d.runCommand)
	case "adminCommand":
		return d.vm.ToValue(d.adminCommand)
	case "serverStatus":
		return d.vm.ToValue(d.serverStatus)
	case "currentOp":
		return d.vm.ToValue(d.currentOp)
	case "killOp":
		return d.vm.ToValue(d.killOp)

	// Sync
	case "fsyncLock":
		return d.vm.ToValue(d.fsyncLock)
	case "fsyncUnlock":
		return d.vm.ToValue(d.fsyncUnlock)

	// User management
	case "createUser":
		return d.vm.ToValue(d.createUser)
	case "getUser":
		return d.vm.ToValue(d.getUser)
	case "getUsers":
		return d.vm.ToValue(d.getUsers)
	case "updateUser":
		return d.vm.ToValue(d.updateUser)
	case "dropUser":
		return d.vm.ToValue(d.dropUser)
	case "changeUserPassword":
		return d.vm.ToValue(d.changeUserPassword)
	case "auth":
		return d.vm.ToValue(d.auth)
	case "grantRolesToUser":
		return d.vm.ToValue(d.grantRolesToUser)
	case "revokeRolesFromUser":
		return d.vm.ToValue(d.revokeRolesFromUser)

	// Role management
	case "createRole":
		return d.vm.ToValue(d.createRole)
	case "getRole":
		return d.vm.ToValue(d.getRole)
	case "getRoles":
		return d.vm.ToValue(d.getRoles)
	case "dropRole":
		return d.vm.ToValue(d.dropRole)
	case "grantRolesToRole":
		return d.vm.ToValue(d.grantRolesToRole)
	case "revokeRolesFromRole":
		return d.vm.ToValue(d.revokeRolesFromRole)

	// Help
	case "help":
		return d.vm.ToValue(d.help)

	default:
		// Dynamic collection access: db.users, db.orders, etc.
		return NewCollectionObject(d.vm, d.client, key)
	}
}

// Set handles property assignment on the db object.
func (d *DBObject) Set(key string, val goja.Value) bool {
	return false
}

// Has checks if a property exists on the db object.
func (d *DBObject) Has(key string) bool {
	return true
}

// Delete removes a property from the db object.
func (d *DBObject) Delete(key string) bool {
	return false
}

// Keys returns the known properties of the db object.
func (d *DBObject) Keys() []string {
	return []string{
		"getName", "getCollectionNames", "getCollection", "createCollection",
		"dropDatabase", "stats", "version", "runCommand", "adminCommand",
		"serverStatus", "currentOp", "killOp", "fsyncLock", "fsyncUnlock",
		"createUser", "getUser", "getUsers", "updateUser", "dropUser",
		"changeUserPassword", "auth", "grantRolesToUser", "revokeRolesFromUser",
		"createRole", "getRole", "getRoles", "dropRole",
		"grantRolesToRole", "revokeRolesFromRole", "help",
	}
}

// --- Database identity ---

func (d *DBObject) getName() string {
	return d.client.CurrentDBName()
}

// --- Collection management ---

func (d *DBObject) getCollectionNames() interface{} {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	db := d.client.CurrentDB()
	names, err := db.ListCollectionNames(ctx, bson.D{})
	if err != nil {
		panic(d.vm.NewGoError(err))
	}
	result := make([]interface{}, len(names))
	for i, n := range names {
		result[i] = n
	}
	return result
}

func (d *DBObject) getCollection(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(d.vm.NewTypeError("getCollection requires a collection name"))
	}
	name := call.Arguments[0].String()
	return NewCollectionObject(d.vm, d.client, name)
}

func (d *DBObject) createCollection(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(d.vm.NewTypeError("createCollection requires a collection name"))
	}
	name := call.Arguments[0].String()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	opts := options.CreateCollection()
	if len(call.Arguments) > 1 {
		optsMap := call.Arguments[1].Export()
		if m, ok := optsMap.(map[string]interface{}); ok {
			if capped, ok := m["capped"].(bool); ok && capped {
				opts.SetCapped(true)
			}
			if size, ok := m["size"].(int64); ok {
				opts.SetSizeInBytes(size)
			}
			if size, ok := m["size"].(float64); ok {
				opts.SetSizeInBytes(int64(size))
			}
			if max, ok := m["max"].(int64); ok {
				opts.SetMaxDocuments(max)
			}
			if max, ok := m["max"].(float64); ok {
				opts.SetMaxDocuments(int64(max))
			}
		}
	}

	err := d.client.CurrentDB().CreateCollection(ctx, name, opts)
	if err != nil {
		panic(d.vm.NewGoError(err))
	}

	result := d.vm.NewObject()
	result.Set("ok", 1)
	return result
}

// --- Database operations ---

func (d *DBObject) dropDatabase() interface{} {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	err := d.client.CurrentDB().Drop(ctx)
	if err != nil {
		panic(d.vm.NewGoError(err))
	}
	return map[string]interface{}{"ok": 1, "dropped": d.client.CurrentDBName()}
}

func (d *DBObject) dbStats() interface{} {
	return d.runSimpleCommand(d.client.CurrentDBName(), bson.D{{Key: "dbStats", Value: 1}})
}

func (d *DBObject) version() string {
	v, err := d.client.ServerVersion()
	if err != nil {
		panic(d.vm.NewGoError(err))
	}
	return v
}

// --- Commands ---

func (d *DBObject) runCommand(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(d.vm.NewTypeError("runCommand requires a command document"))
	}
	cmd := convert.JSToGo(d.vm, call.Arguments[0])
	result := d.runSimpleCommand(d.client.CurrentDBName(), cmd)
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) adminCommand(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(d.vm.NewTypeError("adminCommand requires a command document"))
	}
	cmd := convert.JSToGo(d.vm, call.Arguments[0])
	result := d.runSimpleCommand("admin", cmd)
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) serverStatus() interface{} {
	return d.runSimpleCommand("admin", bson.D{{Key: "serverStatus", Value: 1}})
}

func (d *DBObject) currentOp() interface{} {
	return d.runSimpleCommand("admin", bson.D{{Key: "currentOp", Value: 1}})
}

func (d *DBObject) killOp(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(d.vm.NewTypeError("killOp requires an opid"))
	}
	opid := call.Arguments[0].ToInteger()
	result := d.runSimpleCommand("admin", bson.D{{Key: "killOp", Value: 1}, {Key: "op", Value: opid}})
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) fsyncLock() interface{} {
	return d.runSimpleCommand("admin", bson.D{{Key: "fsync", Value: 1}, {Key: "lock", Value: true}})
}

func (d *DBObject) fsyncUnlock() interface{} {
	return d.runSimpleCommand("admin", bson.D{{Key: "fsyncUnlock", Value: 1}})
}

// --- User management ---

func (d *DBObject) createUser(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(d.vm.NewTypeError("createUser requires a user document"))
	}
	userDoc := convert.JSToGo(d.vm, call.Arguments[0])
	cmd := bson.D{{Key: "createUser", Value: ""}}

	if doc, ok := userDoc.(bson.D); ok {
		for _, elem := range doc {
			if elem.Key == "user" {
				cmd[0].Value = elem.Value
			} else {
				cmd = append(cmd, elem)
			}
		}
	}

	result := d.runSimpleCommand(d.client.CurrentDBName(), cmd)
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) getUser(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(d.vm.NewTypeError("getUser requires a username"))
	}
	username := call.Arguments[0].String()
	result := d.runSimpleCommand(d.client.CurrentDBName(), bson.D{
		{Key: "usersInfo", Value: bson.D{{Key: "user", Value: username}, {Key: "db", Value: d.client.CurrentDBName()}}},
	})
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) getUsers() interface{} {
	return d.runSimpleCommand(d.client.CurrentDBName(), bson.D{{Key: "usersInfo", Value: 1}})
}

func (d *DBObject) updateUser(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(d.vm.NewTypeError("updateUser requires a username and update document"))
	}
	username := call.Arguments[0].String()
	updateDoc := convert.JSToGo(d.vm, call.Arguments[1])

	cmd := bson.D{{Key: "updateUser", Value: username}}
	if doc, ok := updateDoc.(bson.D); ok {
		cmd = append(cmd, doc...)
	}

	result := d.runSimpleCommand(d.client.CurrentDBName(), cmd)
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) dropUser(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(d.vm.NewTypeError("dropUser requires a username"))
	}
	username := call.Arguments[0].String()
	result := d.runSimpleCommand(d.client.CurrentDBName(), bson.D{{Key: "dropUser", Value: username}})
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) changeUserPassword(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(d.vm.NewTypeError("changeUserPassword requires username and new password"))
	}
	username := call.Arguments[0].String()
	password := call.Arguments[1].String()
	result := d.runSimpleCommand(d.client.CurrentDBName(), bson.D{
		{Key: "updateUser", Value: username},
		{Key: "pwd", Value: password},
	})
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) auth(call goja.FunctionCall) goja.Value {
	panic(d.vm.NewTypeError("db.auth() is not supported in go-mongosh; use connection string credentials"))
}

func (d *DBObject) grantRolesToUser(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(d.vm.NewTypeError("grantRolesToUser requires username and roles"))
	}
	username := call.Arguments[0].String()
	roles := convert.JSToGo(d.vm, call.Arguments[1])
	result := d.runSimpleCommand(d.client.CurrentDBName(), bson.D{
		{Key: "grantRolesToUser", Value: username},
		{Key: "roles", Value: roles},
	})
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) revokeRolesFromUser(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(d.vm.NewTypeError("revokeRolesFromUser requires username and roles"))
	}
	username := call.Arguments[0].String()
	roles := convert.JSToGo(d.vm, call.Arguments[1])
	result := d.runSimpleCommand(d.client.CurrentDBName(), bson.D{
		{Key: "revokeRolesFromUser", Value: username},
		{Key: "roles", Value: roles},
	})
	return convert.GoToJS(d.vm, result)
}

// --- Role management ---

func (d *DBObject) createRole(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(d.vm.NewTypeError("createRole requires a role document"))
	}
	roleDoc := convert.JSToGo(d.vm, call.Arguments[0])
	cmd := bson.D{{Key: "createRole", Value: ""}}
	if doc, ok := roleDoc.(bson.D); ok {
		for _, elem := range doc {
			if elem.Key == "role" {
				cmd[0].Value = elem.Value
			} else {
				cmd = append(cmd, elem)
			}
		}
	}
	result := d.runSimpleCommand(d.client.CurrentDBName(), cmd)
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) getRole(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(d.vm.NewTypeError("getRole requires a role name"))
	}
	roleName := call.Arguments[0].String()
	result := d.runSimpleCommand(d.client.CurrentDBName(), bson.D{
		{Key: "rolesInfo", Value: bson.D{{Key: "role", Value: roleName}, {Key: "db", Value: d.client.CurrentDBName()}}},
	})
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) getRoles() interface{} {
	return d.runSimpleCommand(d.client.CurrentDBName(), bson.D{{Key: "rolesInfo", Value: 1}})
}

func (d *DBObject) dropRole(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 1 {
		panic(d.vm.NewTypeError("dropRole requires a role name"))
	}
	roleName := call.Arguments[0].String()
	result := d.runSimpleCommand(d.client.CurrentDBName(), bson.D{{Key: "dropRole", Value: roleName}})
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) grantRolesToRole(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(d.vm.NewTypeError("grantRolesToRole requires role name and roles"))
	}
	roleName := call.Arguments[0].String()
	roles := convert.JSToGo(d.vm, call.Arguments[1])
	result := d.runSimpleCommand(d.client.CurrentDBName(), bson.D{
		{Key: "grantRolesToRole", Value: roleName},
		{Key: "roles", Value: roles},
	})
	return convert.GoToJS(d.vm, result)
}

func (d *DBObject) revokeRolesFromRole(call goja.FunctionCall) goja.Value {
	if len(call.Arguments) < 2 {
		panic(d.vm.NewTypeError("revokeRolesFromRole requires role name and roles"))
	}
	roleName := call.Arguments[0].String()
	roles := convert.JSToGo(d.vm, call.Arguments[1])
	result := d.runSimpleCommand(d.client.CurrentDBName(), bson.D{
		{Key: "revokeRolesFromRole", Value: roleName},
		{Key: "roles", Value: roles},
	})
	return convert.GoToJS(d.vm, result)
}

// --- Help ---

func (d *DBObject) help() string {
	return `Database Methods:
  db.getName()                    Get current database name
  db.getCollectionNames()         List all collections
  db.getCollection(name)          Get a collection by name
  db.createCollection(name,opts)  Create a new collection
  db.dropDatabase()               Drop the current database
  db.stats()                      Database statistics
  db.version()                    Server version
  db.runCommand(cmd)              Run a database command
  db.adminCommand(cmd)            Run an admin command
  db.serverStatus()               Server status
  db.currentOp()                  Current operations
  db.killOp(opid)                 Kill an operation

User Management:
  db.createUser(doc)              Create a user
  db.getUser(name)                Get user info
  db.getUsers()                   List all users
  db.updateUser(name, doc)        Update a user
  db.dropUser(name)               Drop a user
  db.changeUserPassword(n, p)     Change password
  db.grantRolesToUser(n, roles)   Grant roles
  db.revokeRolesFromUser(n, r)    Revoke roles

Role Management:
  db.createRole(doc)              Create a role
  db.getRole(name)                Get role info
  db.getRoles()                   List all roles
  db.dropRole(name)               Drop a role`
}

// --- Internal helpers ---

func (d *DBObject) runSimpleCommand(dbName string, cmd interface{}) interface{} {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	var result bson.D
	err := d.client.Inner().Database(dbName).RunCommand(ctx, cmd).Decode(&result)
	if err != nil {
		panic(d.vm.NewGoError(fmt.Errorf("command failed: %w", err)))
	}
	return result
}
