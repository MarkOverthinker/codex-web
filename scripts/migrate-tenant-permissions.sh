#!/usr/bin/env bash
set -Eeuo pipefail

# Compatibility wrapper: tenant permissions are now applied by the Node
# implementation so identities can come from the runtime identities file.
exec node /app/scripts/apply-tenant-permissions.mjs
