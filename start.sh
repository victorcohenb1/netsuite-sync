#!/bin/sh
echo "=== Running Prisma DB Push ==="
./node_modules/.bin/prisma db push --accept-data-loss 2>&1
echo "=== Prisma db push exit code: $? ==="
echo "=== Starting Application ==="
exec node dist/index.js
