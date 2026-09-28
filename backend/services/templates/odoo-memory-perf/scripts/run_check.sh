#!/usr/bin/env bash
# Empirical memory-leak check: runs any existing --test-tags-selectable test
# through the memleak_check addon (dumping 3 heap snapshots around whatever
# browser session that test creates), then hands those snapshots to memlab
# for offline analysis. Not a special mode — <test_tags> is the exact same
# value you'd give odoo-bin's own --test-tags.
# Usage: run_check.sh <test_tags> <modules_to_install> [db_name]
set -euo pipefail

TEST_TAGS="${1:?usage: run_check.sh <test_tags> <modules_to_install> [db_name]}"
MODULES="${2:?usage: run_check.sh <test_tags> <modules_to_install> [db_name]}"
DB="${3:-memcheck_$$}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# .claude/skills/odoo-memory-perf/scripts -> worktree root -> community/
WORKTREE_ROOT="$(cd "$HERE/../../../.." && pwd)"
COMMUNITY="$WORKTREE_ROOT/community"

# --work-dir persists memlab's report (by default it writes to a temp dir that's
# gone once the run ends): <DUMP_DIR>/data/cur/leaks.txt, plus the raw
# baseline/target/final .heapsnapshot files the ChromeBrowser patch writes here
# directly (see test_memleak_check.py)
DUMP_DIR="$HERE/../dumps/memcheck_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$DUMP_DIR"

cleanup() {
  dropdb --if-exists "$DB" 2>/dev/null || true
}
trap cleanup EXIT

echo "installing memleak_check,$MODULES and running '$TEST_TAGS' (db: $DB)..."
# --test-tags --stop-after-init runs synchronously and exits on its own — no
# background process or port to manage, unlike a long-running server
(
  cd "$COMMUNITY"
  export MEMCHECK_DUMP_DIR="$DUMP_DIR"
  ./odoo-bin -c ../odoo.conf -d "$DB" \
    -i "memleak_check,$MODULES" \
    --test-tags "$TEST_TAGS" --test-enable --stop-after-init --without-demo all
)

echo "analyzing the 3 snapshots with memlab..."
npx --yes memlab@latest find-leaks \
  --baseline "$DUMP_DIR/baseline.heapsnapshot" \
  --target "$DUMP_DIR/target.heapsnapshot" \
  --final "$DUMP_DIR/final.heapsnapshot" \
  --work-dir "$DUMP_DIR"

echo
echo "dump saved: $DUMP_DIR/ (*.heapsnapshot, data/cur/leaks.txt)"
