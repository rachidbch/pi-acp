#!/bin/sh
# Test wrapper for PI_ACP_PI_COMMAND: records pi's argv (one per line) in $RECORD_ARGV_FILE,
# then execs $RECORD_ARGV_TARGET with the same args. pi sets process.title, so ps cannot show them.
printf '%s\n' "$@" > "$RECORD_ARGV_FILE"
exec "$RECORD_ARGV_TARGET" "$@"
