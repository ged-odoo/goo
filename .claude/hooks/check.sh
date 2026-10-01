#!/usr/bin/env bash
# Stop: before Claude ends a turn, run the checks relevant to what this branch
# changed (vs master, plus uncommitted work). On failure, exit 2 sends the output
# back to Claude, which has to fix it before stopping. Skipped when nothing changed
# since the last run that passed, so a Q&A turn costs nothing.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
input=$(cat)

message() { # a note shown to the user (not blocking)
  python3 -c 'import json,sys; print(json.dumps({"systemMessage": sys.argv[1]}))' "$1"
}

# skip if the tree is exactly as it was when the checks last passed
stamp="$(git rev-parse --git-path goo-check-stamp)"
state=$({ git rev-parse HEAD; git status --porcelain; git diff HEAD; } 2>/dev/null | sha1sum)
[ "$state" = "$(cat "$stamp" 2>/dev/null)" ] && exit 0

base=$(git merge-base HEAD upstream/master 2>/dev/null || git merge-base HEAD origin/master 2>/dev/null || echo HEAD)
changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)
[ -n "$changed" ] || exit 0

fail=""
notes=""
run() { # run <label> <cmd...>: collect the output of a failing check
  local out
  out=$("${@:2}" 2>&1) || fail+=$'\n'"### $1 failed:"$'\n'"$(echo "$out" | tail -40)"$'\n'
}

if grep -qE '\.py$|^pyproject\.toml$' <<<"$changed"; then
  command -v ruff >/dev/null && run "ruff check" ruff check -q
  if grep -qE '^(backend/.*\.py|goo\.py|pyproject\.toml)$' <<<"$changed"; then
    run "pyright (npx pyright)" npx --yes pyright
  fi
  run "backend tests (python3 -m unittest discover)" python3 -m unittest discover -q
fi
if grep -qE '^(static/(src|tests)/|vendor/owl-orm/|package(-lock)?\.json$|tsconfig\.json$|vitest|eslint)' <<<"$changed"; then
  if [ -d node_modules ]; then
    run "types (npm run typecheck:ts)" npm run -s typecheck:ts
    run "eslint (npm run lint)" npm run -s lint
    run "frontend tests (npm run test)" npm run -s test
    before=$(sha1sum static/dist/app.js)
    npm run -s build >/dev/null 2>&1
    [ "$before" = "$(sha1sum static/dist/app.js)" ] ||
      notes+="static/dist/app.js was out of date and has been rebuilt. "
  else
    notes+="Frontend checks skipped: run npm install. "
  fi
fi

if [ -z "$fail" ]; then
  # the bundle rebuild changes the tree: stamp the state after it
  { git rev-parse HEAD; git status --porcelain; git diff HEAD; } 2>/dev/null | sha1sum >"$stamp"
  [ -n "$notes" ] && message "$notes"
  exit 0
fi
if grep -qE '"stop_hook_active" *: *true' <<<"$input"; then
  # already blocked once this turn: don't loop forever, tell the user instead
  message "Checks still failing:$fail"
  exit 0
fi
echo "Checks failed — fix before finishing:$fail" >&2
exit 2
