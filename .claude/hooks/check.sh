#!/usr/bin/env bash
# Stop: before Claude ends a turn, run the checks relevant to what this branch
# changed (vs master, plus uncommitted work). On failure, exit 2 sends the output
# back to Claude, which has to fix it before stopping. A Q&A turn with no code
# change on the branch costs nothing.
cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0
input=$(cat)

base=$(git merge-base HEAD upstream/master 2>/dev/null || git merge-base HEAD origin/master 2>/dev/null || echo HEAD)
changed=$( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } | sort -u)
[ -n "$changed" ] || exit 0

fail=""
run() { # run <label> <cmd...>: collect the output of a failing check
  local out
  out=$("${@:2}" 2>&1) || fail+=$'\n'"### $1 failed:"$'\n'"$(echo "$out" | tail -40)"$'\n'
}

if grep -qE '\.py$|^pyproject\.toml$' <<<"$changed"; then
  command -v ruff >/dev/null && run "ruff check" ruff check -q
  run "pyright (npm run typecheck:py)" npm run -s typecheck:py
  run "backend tests (python3 -m unittest discover)" python3 -m unittest discover -q
fi
if grep -qE '^(static/(src|tests)/|vendor/owl-orm/|package(-lock)?\.json$|vitest)' <<<"$changed"; then
  run "eslint (npm run lint)" npm run -s lint
  run "frontend tests (npm run test)" npm run -s test
  before=$(sha1sum static/dist/app.js)
  npm run -s build >/dev/null 2>&1
  [ "$before" = "$(sha1sum static/dist/app.js)" ] ||
    fail+=$'\n'"### static/dist/app.js was stale: it has just been rebuilt — include it in the commit."$'\n'
fi

[ -z "$fail" ] && exit 0
if [ "$(jq -r '.stop_hook_active // false' <<<"$input")" = "true" ]; then
  # already blocked once this turn: don't loop forever, tell the user instead
  jq -n --arg m "Checks still failing:$fail" '{systemMessage: $m}'
  exit 0
fi
echo "Checks failed — fix before finishing:$fail" >&2
exit 2
