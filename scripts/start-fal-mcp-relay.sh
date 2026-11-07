#!/usr/bin/env bash
# Start the fal.ai metered MCP relay. Kept for the release image and old callers.
exec bash "$(cd "$(dirname "$0")" && pwd)/start-metered-mcp-relay.sh" fal 8797
