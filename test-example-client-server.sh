#!/bin/bash

# Kill any existing server processes
pkill -f examples/basic/server.ts 2>/dev/null || true
pkill -f examples/basic/client.ts 2>/dev/null || true

# Start the server in the background
pnpm run example:basic:server > /dev/null 2>&1 &
SERVER_PID=$!

# Give the server time to start
sleep 2

# Run the client
pnpm run example:basic:client

# Kill the server
kill $SERVER_PID 2>/dev/null || true
