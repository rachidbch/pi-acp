#!/bin/sh
# Test wrapper for PI_ACP_PI_COMMAND: records pi's argv (one per line) in $RECORD_ARGV_FILE,
# then execs $RECORD_ARGV_TARGET with the same args. pi sets process.title, so ps cannot show them.
# The test suite isolates HOME (test/helpers/isolate-home.ts); real pi needs the real one
# for its credentials.
printf '%s\n' "$@" > "$RECORD_ARGV_FILE"
if [ -n "$PI_ACP_TEST_REAL_HOME" ]; then HOME="$PI_ACP_TEST_REAL_HOME"; export HOME; fi
exec "$RECORD_ARGV_TARGET" "$@"
