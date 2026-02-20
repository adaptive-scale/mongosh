package mongoclient

import (
	"context"
	"crypto/rand"
	"fmt"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// Client wraps the MongoDB driver client with convenience methods.
type Client struct {
	inner  *mongo.Client
	uri    string
	dbName string
}

// Connect creates a new MongoDB client and verifies the connection.
func Connect(uri string) (*Client, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	opts := options.Client().ApplyURI(uri)
	client, err := mongo.Connect(opts)
	if err != nil {
		return nil, fmt.Errorf("connect ECONNREFUSED: %w", err)
	}

	if err := client.Ping(ctx, nil); err != nil {
		return nil, fmt.Errorf("connect ECONNREFUSED: %w", err)
	}

	dbName := "test"

	return &Client{
		inner:  client,
		uri:    uri,
		dbName: dbName,
	}, nil
}

// Disconnect closes the MongoDB connection.
func (c *Client) Disconnect() error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return c.inner.Disconnect(ctx)
}

// Inner returns the underlying mongo.Client.
func (c *Client) Inner() *mongo.Client {
	return c.inner
}

// URI returns the connection URI.
func (c *Client) URI() string {
	return c.uri
}

// Database returns a handle to the named database.
func (c *Client) Database(name string) *mongo.Database {
	return c.inner.Database(name)
}

// CurrentDBName returns the current default database name.
func (c *Client) CurrentDBName() string {
	return c.dbName
}

// SetCurrentDB changes the current default database.
func (c *Client) SetCurrentDB(name string) {
	c.dbName = name
}

// CurrentDB returns the current default database.
func (c *Client) CurrentDB() *mongo.Database {
	return c.inner.Database(c.dbName)
}

// ListDatabaseNames returns all database names.
func (c *Client) ListDatabaseNames() ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.inner.ListDatabaseNames(ctx, bson.D{})
}

// RunCommand runs a raw command against the given database.
func (c *Client) RunCommand(dbName string, cmd interface{}) *mongo.SingleResult {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return c.inner.Database(dbName).RunCommand(ctx, cmd)
}

// ServerVersion returns the MongoDB server version string.
func (c *Client) ServerVersion() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var result bson.M
	err := c.inner.Database("admin").RunCommand(ctx, bson.D{{Key: "buildInfo", Value: 1}}).Decode(&result)
	if err != nil {
		return "", err
	}
	if v, ok := result["version"].(string); ok {
		return v, nil
	}
	return "unknown", nil
}

// GenerateLogID generates a random hex log ID similar to mongosh.
func GenerateLogID() string {
	b := make([]byte, 12)
	rand.Read(b)
	return fmt.Sprintf("%x", b)
}
