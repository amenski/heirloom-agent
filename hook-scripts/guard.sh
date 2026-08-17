#!/bin/sh
# PreToolUse guard: block any run_bash call whose command contains "rm -rf".
# Reads the hook JSON payload from stdin, exits 2 (block) on a match.

payload="$(cat)"

case "$payload" in
  *"rm -rf"*)
    exit 2
    ;;
  *)
    exit 0
    ;;
esac
