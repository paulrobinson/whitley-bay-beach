#!/bin/bash
set -euo pipefail

# Only run in Claude Code web (remote) environments
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Sync to the latest main so sessions never start from a stale snapshot
git fetch origin main
git checkout main
git reset --hard origin/main

# Install dependencies
npm install
