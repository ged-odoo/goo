#!/usr/bin/env bash
# PostToolUse (Edit|Write): format + lint the file Claude just changed, the same
# way pre-commit would. Lint errors that can't be auto-fixed are sent back to
# Claude (exit 2) so it fixes them in the same turn.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
f=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')
[ -f "$f" ] || exit 0
f=$(realpath --relative-to=. "$f")
case "$f" in
  ../*) exit 0 ;; # outside the repo
  *.py)
    command -v ruff >/dev/null || exit 0
    ruff format --force-exclude -q "$f"
    out=$(ruff check --force-exclude --fix -q "$f" 2>&1) || { echo "$out" >&2; exit 2; }
    ;;
  static/src/*.js)
    npx prettier --write --log-level=warn "$f" >/dev/null
    out=$(npx eslint --fix "$f" 2>&1) || { echo "$out" >&2; exit 2; }
    ;;
  *.js | *.css | *.html | *.json | *.md)
    npx prettier --write --log-level=warn --ignore-unknown "$f" >/dev/null
    ;;
esac
exit 0
