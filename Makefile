BINARY      := mongo-sh
VERSION     := $(shell sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -1)
TAG         ?= v$(VERSION)
DIST_DIR    := dist
BUILD_IMAGE := mongo-sh-build
PLATFORMS   := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

# Reference MongoDB + mongosh used by the parity suite.
PARITY_CONTAINER ?= mongo-sh-parity
PARITY_PORT      ?= 27717
PARITY_IMAGE     ?= mongo:8.0

.PHONY: help build install test e2e parity parity-record parity-server parity-server-stop \
        build-image release release-dry gh-release clean

## help: Show this help message
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  build               Build $(BINARY) for the current platform (target/release/$(BINARY))"
	@echo "  install             Install $(BINARY) into ~/.cargo/bin"
	@echo "  test                Run the Rust unit tests"
	@echo "  e2e                 Run the end-to-end shell tests (needs MongoDB, see tests/.env.example)"
	@echo "  parity              Compare $(BINARY) with the recorded output of the real mongosh"
	@echo "  parity-record       Re-record that output from the real mongosh (Docker)"
	@echo "  parity-server       Start the MongoDB + mongosh container the parity suite uses"
	@echo "  parity-server-stop  Remove that container"
	@echo "  release             Cross-compile every platform in Docker and package archives into $(DIST_DIR)/"
	@echo "                      (limit with PLATFORMS='linux/amd64 darwin/arm64')"
	@echo "  release-dry         List the archives 'release' produces"
	@echo "  gh-release          Create GitHub release $(TAG) from $(DIST_DIR)/ (requires gh CLI)"
	@echo "  clean               Remove build artifacts"

build:
	cargo build --release

install:
	cargo install --path . --locked

test:
	cargo test

# End-to-end shell tests against a live MongoDB instance
e2e: build
	bash tests/run_all.sh

# Output parity with the real mongosh (see tests/parity/parity.sh)
parity:
	cargo build
	bash tests/parity/parity.sh

parity-record:
	bash tests/parity/parity.sh --record

# A single-node replica set with authentication, plus the real mongosh.
parity-server:
	docker run -d --name $(PARITY_CONTAINER) -p 127.0.0.1:$(PARITY_PORT):27017 \
		-e MONGO_INITDB_ROOT_USERNAME=admin -e MONGO_INITDB_ROOT_PASSWORD=password $(PARITY_IMAGE) \
		bash -c 'openssl rand -base64 756 > /tmp/keyfile && chmod 400 /tmp/keyfile && chown mongodb:mongodb /tmp/keyfile && exec docker-entrypoint.sh mongod --replSet rs0 --keyFile /tmp/keyfile --bind_ip_all'
	@echo "waiting for mongod..."
	@for i in $$(seq 1 60); do \
		docker exec $(PARITY_CONTAINER) mongosh --quiet -u admin -p password --eval 'db.runCommand({ping: 1}).ok' 2>/dev/null | grep -q 1 && break; \
		sleep 1; \
	done
	docker exec $(PARITY_CONTAINER) mongosh --quiet -u admin -p password \
		--eval 'rs.initiate({_id: "rs0", members: [{_id: 0, host: "localhost:27017"}]})'

parity-server-stop:
	docker rm -f $(PARITY_CONTAINER)

# Cross-compile for all platforms inside Docker (see Dockerfile.build)
build-image:
	docker build -f Dockerfile.build -t $(BUILD_IMAGE) .

release: build-image
	docker run --rm -v "$(CURDIR)":/src -v mongo-sh-cargo-registry:/usr/local/cargo/registry \
		-v mongo-sh-build-target:/build/target $(BUILD_IMAGE) $(PLATFORMS)

# List archives that would be produced (dry run)
release-dry:
	@echo "Version: $(VERSION)"
	@echo "Archives:"
	@$(foreach p,$(PLATFORMS), \
		echo "  $(DIST_DIR)/$(BINARY)-$(word 1,$(subst /, ,$(p)))-$(word 2,$(subst /, ,$(p)))$(if $(filter windows,$(word 1,$(subst /, ,$(p)))),.zip,.tar.gz)"; \
	)

# Create a GitHub release and upload artifacts (requires gh CLI)
gh-release:
	gh release create $(TAG) $(DIST_DIR)/*.tar.gz $(DIST_DIR)/*.zip $(DIST_DIR)/checksums.txt \
		--title "$(BINARY) $(TAG)" \
		--generate-notes

clean:
	cargo clean
	rm -rf $(DIST_DIR)
