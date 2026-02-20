package repl

import (
	"strings"

	"github.com/adaptive-scale/go-mongosh/internal/mongoclient"
)

// shellCommands are the top-level shell commands available.
var shellCommands = []string{
	"show dbs", "show databases", "show collections", "show users", "show roles",
	"show profile", "show logs",
	"use ", "exit", "quit", "help", "cls",
	"db.", "rs.", "sh.",
	"ObjectId(", "ISODate(", "NumberLong(", "NumberInt(", "NumberDecimal(",
	"UUID(", "Timestamp(",
}

// dbMethods are the methods available on the db object.
var dbMethods = []string{
	"getName()", "getCollectionNames()", "getCollection(", "createCollection(",
	"dropDatabase()", "stats()", "version()",
	"runCommand(", "adminCommand(", "serverStatus()", "currentOp()", "killOp(",
	"fsyncLock()", "fsyncUnlock()",
	"createUser(", "getUser(", "getUsers()", "updateUser(", "dropUser(",
	"changeUserPassword(", "grantRolesToUser(", "revokeRolesFromUser(",
	"createRole(", "getRole(", "getRoles()", "dropRole(",
	"grantRolesToRole(", "revokeRolesFromRole(",
	"help()",
}

// collectionMethods are the methods available on collection objects.
var collectionMethods = []string{
	"find(", "findOne(", "insertOne(", "insertMany(",
	"updateOne(", "updateMany(", "replaceOne(",
	"deleteOne(", "deleteMany(",
	"findOneAndUpdate(", "findOneAndReplace(", "findOneAndDelete(", "findAndModify(",
	"aggregate(", "countDocuments(", "estimatedDocumentCount()", "distinct(",
	"createIndex(", "createIndexes(", "dropIndex(", "dropIndexes()", "getIndexes()",
	"drop()", "renameCollection(", "stats()", "validate()", "isCapped()",
	"bulkWrite(", "explain(",
	"getName()", "help()",
}

// rsMethods are the methods available on the rs object.
var rsMethods = []string{
	"status()", "conf()", "config()", "initiate(", "reconfig(",
	"add(", "remove(", "stepDown(", "freeze(", "syncFrom(",
	"secondaryOk()", "help()",
}

// shMethods are the methods available on the sh object.
var shMethods = []string{
	"status()", "addShard(", "removeShard(", "enableSharding(",
	"shardCollection(", "moveChunk(",
	"getBalancerState()", "isBalancerRunning()", "startBalancer()", "stopBalancer()",
	"help()",
}

// Completer provides tab completion for the REPL.
type Completer struct {
	client *mongoclient.Client
}

// NewCompleter creates a new tab completer.
func NewCompleter(client *mongoclient.Client) *Completer {
	return &Completer{client: client}
}

// Complete returns completion candidates for the given line.
func (c *Completer) Complete(line string) []string {
	line = strings.TrimLeft(line, " \t")

	// db.collectionName.method completion
	if strings.HasPrefix(line, "db.") {
		after := line[3:]

		// Check if we're completing a method on a collection
		if dotIdx := strings.Index(after, "."); dotIdx >= 0 {
			// db.collectionName.xxx
			prefix := after[dotIdx+1:]
			var matches []string
			for _, m := range collectionMethods {
				if strings.HasPrefix(m, prefix) {
					matches = append(matches, line[:3+dotIdx+1]+m)
				}
			}
			return matches
		}

		// db.xxx - completing collection names or db methods
		var matches []string

		// DB methods
		for _, m := range dbMethods {
			if strings.HasPrefix(m, after) {
				matches = append(matches, "db."+m)
			}
		}

		// Collection names
		names := c.getCollectionNames()
		for _, name := range names {
			if strings.HasPrefix(name, after) {
				matches = append(matches, "db."+name)
			}
		}

		return matches
	}

	// rs.method completion
	if strings.HasPrefix(line, "rs.") {
		prefix := line[3:]
		var matches []string
		for _, m := range rsMethods {
			if strings.HasPrefix(m, prefix) {
				matches = append(matches, "rs."+m)
			}
		}
		return matches
	}

	// sh.method completion
	if strings.HasPrefix(line, "sh.") {
		prefix := line[3:]
		var matches []string
		for _, m := range shMethods {
			if strings.HasPrefix(m, prefix) {
				matches = append(matches, "sh."+m)
			}
		}
		return matches
	}

	// Top-level commands
	var matches []string
	for _, cmd := range shellCommands {
		if strings.HasPrefix(cmd, line) {
			matches = append(matches, cmd)
		}
	}

	return matches
}

func (c *Completer) getCollectionNames() []string {
	names, err := c.client.CurrentDB().ListCollectionNames(nil, map[string]interface{}{})
	if err != nil {
		return nil
	}
	return names
}
