BINARY    := mongosh
MODULE    := github.com/adaptive-scale/go-mongosh
VERSION   ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS   := -s -w -X main.version=$(VERSION)
BUILD_DIR := dist

PLATFORMS := linux/amd64 linux/arm64 darwin/amd64 darwin/arm64 windows/amd64 windows/arm64

.PHONY: build clean test e2e release release-dry gh-release help $(PLATFORMS)

## help: Show this help message
help:
	@echo "Usage: make [target]"
	@echo ""
	@echo "Targets:"
	@echo "  build          Build the $(BINARY) binary for the current platform"
	@echo "  test           Run Go unit tests"
	@echo "  clean          Remove build artifacts (binary and dist/)"
	@echo "  release        Cross-compile for all platforms and package archives"
	@echo "  release-dry    Show the archives that would be produced (dry run)"
	@echo "  e2e            Run end-to-end shell tests (requires MongoDB connection)"
	@echo "  gh-release     Create a GitHub release and upload artifacts (requires gh CLI)"
	@echo "  help           Show this help message"

build:
	go build -ldflags '$(LDFLAGS)' -o $(BINARY) ./cmd/mongosh

test:
	go test ./...

clean:
	rm -rf $(BINARY) $(BUILD_DIR)

# Run end-to-end shell tests against a live MongoDB instance
e2e: build
	bash tests/run_all.sh

# Cross-compile for all platforms
release: clean $(PLATFORMS)

$(PLATFORMS):
	$(eval GOOS := $(word 1,$(subst /, ,$@)))
	$(eval GOARCH := $(word 2,$(subst /, ,$@)))
	$(eval EXT := $(if $(filter windows,$(GOOS)),.exe,))
	$(eval ARCHIVE_DIR := $(BUILD_DIR)/$(BINARY)-$(VERSION)-$(GOOS)-$(GOARCH))
	@mkdir -p $(ARCHIVE_DIR)
	GOOS=$(GOOS) GOARCH=$(GOARCH) go build -ldflags '$(LDFLAGS)' -o $(ARCHIVE_DIR)/$(BINARY)$(EXT) ./cmd/mongosh
	@if [ "$(GOOS)" = "windows" ]; then \
		cd $(BUILD_DIR) && zip -qr $(BINARY)-$(VERSION)-$(GOOS)-$(GOARCH).zip $(BINARY)-$(VERSION)-$(GOOS)-$(GOARCH); \
	else \
		tar -czf $(BUILD_DIR)/$(BINARY)-$(VERSION)-$(GOOS)-$(GOARCH).tar.gz -C $(BUILD_DIR) $(BINARY)-$(VERSION)-$(GOOS)-$(GOARCH); \
	fi
	@rm -rf $(ARCHIVE_DIR)

# List archives that would be produced (dry run)
release-dry:
	@echo "Version: $(VERSION)"
	@echo "Archives:"
	@$(foreach p,$(PLATFORMS), \
		echo "  $(BUILD_DIR)/$(BINARY)-$(VERSION)-$(word 1,$(subst /, ,$(p)))-$(word 2,$(subst /, ,$(p)))$(if $(filter windows,$(word 1,$(subst /, ,$(p)))),.zip,.tar.gz)"; \
	)

# Create a GitHub release and upload artifacts (requires gh CLI)
gh-release: release
	gh release create $(VERSION) $(BUILD_DIR)/*.tar.gz $(BUILD_DIR)/*.zip \
		--title "$(BINARY) $(VERSION)" \
		--generate-notes
