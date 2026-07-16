#!/usr/bin/env bash
# Exercises scripts/deploy.sh against a fake root, a file:// "GitHub API", and
# stubbed systemctl/journalctl — no sudo, systemd, or network. Run by CI (lint
# job) and locally: bash scripts/test_deploy.sh
set -euo pipefail
export LC_ALL=C

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

# --- fixtures -----------------------------------------------------------------
# Stub systemctl/journalctl that record their invocations.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$tmp/systemctl.log"
exit 0
EOF
cat > "$tmp/bin/journalctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$tmp/journalctl.log"
EOF
chmod +x "$tmp/bin/systemctl" "$tmp/bin/journalctl"

make_release() { # <repo> <tag> <asset>...
    local repo=$1 tag=$2 assets_dir="$tmp/assets/$1/$2"
    shift 2
    mkdir -p "$assets_dir"
    for name in "$@"; do
        cp "$tmp/staging/$name" "$assets_dir/$name"
    done
    (cd "$assets_dir" && sha256sum "$@" > SHA256SUMS)
    local api_dir="$tmp/api/repos/$repo/releases"
    mkdir -p "$api_dir/tags"
    python3 - "$assets_dir" "$tag" "$api_dir" <<'EOF'
import json, os, sys
assets_dir, tag, api_dir = sys.argv[1:]
release = {
    "tag_name": tag,
    "assets": [
        {"name": n, "browser_download_url": "file://" + os.path.join(assets_dir, n)}
        for n in sorted(os.listdir(assets_dir))
    ],
}
for path in (os.path.join(api_dir, "latest"), os.path.join(api_dir, "tags", tag)):
    with open(path, "w") as f:
        json.dump(release, f)
EOF
}

reset_root() {
    rm -rf "$tmp/root"
    mkdir -p "$tmp/root/home/fbl/keydates-worker"
    printf 'old-binary\n' > "$tmp/root/home/fbl/bsky-event-ingester"
    chmod +x "$tmp/root/home/fbl/bsky-event-ingester"
    printf 'old-worker\n' > "$tmp/root/home/fbl/keydates-worker/keydates_worker.py"
    printf 'old-labeler\n' > "$tmp/root/home/fbl/bsky-labeler"
    chmod +x "$tmp/root/home/fbl/bsky-labeler"
    rm -f "$tmp/systemctl.log" "$tmp/journalctl.log"
}

mkdir -p "$tmp/staging"
printf 'new-binary\n' > "$tmp/staging/bsky-event-ingester"
printf 'new-worker\n' > "$tmp/staging/keydates_worker.py"
printf 'new-labeler\n' > "$tmp/staging/bsky-labeler"
make_release consfyi/bsky-event-ingester deploy-test-1 bsky-event-ingester keydates_worker.py
make_release consfyi/bsky-labeler deploy-test-1 bsky-labeler
printf 'ok\n' > "$tmp/health-ok"

deploy() {
    DEPLOY_API_BASE="file://$tmp/api" \
    DEPLOY_ROOT="$tmp/root" \
    DEPLOY_SUDO='' \
    DEPLOY_SYSTEMCTL="$tmp/bin/systemctl" \
    DEPLOY_JOURNALCTL="$tmp/bin/journalctl" \
    DEPLOY_SETTLE_SECS=0 \
    DEPLOY_HEALTH_URL="file://$tmp/health-ok" \
    bash "$here/deploy.sh" "$@"
}

expect_content() { # <file> <content> <what>
    [ "$(cat "$1")" = "$2" ] || fail "$3: $1 contains '$(cat "$1")', expected '$2'"
}

# --- 1. ingester happy path ----------------------------------------------------
reset_root
deploy ingester > "$tmp/out1" 2>&1 || { cat "$tmp/out1"; fail "ingester deploy exited non-zero"; }
expect_content "$tmp/root/home/fbl/bsky-event-ingester" new-binary "binary not swapped"
expect_content "$tmp/root/home/fbl/bsky-event-ingester.bak" old-binary "no .bak snapshot"
expect_content "$tmp/root/home/fbl/keydates-worker/keydates_worker.py" new-worker "worker not swapped"
expect_content "$tmp/root/home/fbl/keydates-worker/keydates_worker.py.bak" old-worker "no worker .bak"
[ -x "$tmp/root/home/fbl/bsky-event-ingester" ] || fail "deployed binary not executable"
grep -q "restart fbl-bsky-event-ingester" "$tmp/systemctl.log" || fail "unit not restarted"
grep -q "deploy-test-1" "$tmp/out1" || fail "deployed tag not reported"

# --- 2. rollback ----------------------------------------------------------------
deploy ingester --rollback > "$tmp/out2" 2>&1 || { cat "$tmp/out2"; fail "rollback exited non-zero"; }
expect_content "$tmp/root/home/fbl/bsky-event-ingester" old-binary "binary not rolled back"
expect_content "$tmp/root/home/fbl/keydates-worker/keydates_worker.py" old-worker "worker not rolled back"
[ ! -e "$tmp/root/home/fbl/bsky-event-ingester.bak" ] || fail "rollback left a stale .bak"
[ "$(grep -c "restart fbl-bsky-event-ingester" "$tmp/systemctl.log")" = 2 ] || fail "rollback did not restart"

# --- 3. tampered artifact must abort before touching the root -------------------
reset_root
printf 'evil\n' > "$tmp/assets/consfyi/bsky-event-ingester/deploy-test-1/bsky-event-ingester"
if deploy ingester > "$tmp/out3" 2>&1; then
    fail "deploy succeeded with a tampered artifact"
fi
grep -q "checksum verification failed" "$tmp/out3" || { cat "$tmp/out3"; fail "wrong error for tampered artifact"; }
expect_content "$tmp/root/home/fbl/bsky-event-ingester" old-binary "tampered deploy modified the binary"
[ ! -e "$tmp/root/home/fbl/bsky-event-ingester.bak" ] || fail "tampered deploy left a .bak"
[ ! -s "$tmp/systemctl.log" ] || fail "tampered deploy touched systemd"
# restore the asset for later tests
cp "$tmp/staging/bsky-event-ingester" "$tmp/assets/consfyi/bsky-event-ingester/deploy-test-1/bsky-event-ingester"

# --- 4. a file missing from SHA256SUMS must abort --------------------------------
# (--ignore-missing alone would silently skip an unlisted file; the script must
# insist every installed file was actually verified.)
reset_root
grep -v keydates_worker.py "$tmp/assets/consfyi/bsky-event-ingester/deploy-test-1/SHA256SUMS" > "$tmp/sums.trimmed"
cp "$tmp/sums.trimmed" "$tmp/assets/consfyi/bsky-event-ingester/deploy-test-1/SHA256SUMS"
if deploy ingester > "$tmp/out4" 2>&1; then
    fail "deploy succeeded with a file missing from SHA256SUMS"
fi
grep -q "not covered by SHA256SUMS" "$tmp/out4" || { cat "$tmp/out4"; fail "wrong error for uncovered file"; }
expect_content "$tmp/root/home/fbl/bsky-event-ingester" old-binary "uncovered deploy modified the binary"
# restore the manifest
(cd "$tmp/assets/consfyi/bsky-event-ingester/deploy-test-1" && sha256sum bsky-event-ingester keydates_worker.py > SHA256SUMS)

# --- 5. labeler happy path incl. health check ------------------------------------
reset_root
deploy labeler > "$tmp/out5" 2>&1 || { cat "$tmp/out5"; fail "labeler deploy exited non-zero"; }
expect_content "$tmp/root/home/fbl/bsky-labeler" new-labeler "labeler binary not swapped"
expect_content "$tmp/root/home/fbl/bsky-labeler.bak" old-labeler "no labeler .bak"
grep -q "restart fbl-bsky-labeler" "$tmp/systemctl.log" || fail "labeler unit not restarted"
grep -q "health check OK" "$tmp/out5" || fail "labeler health check not run"

# --- 6. --version selects the tagged release --------------------------------------
reset_root
deploy ingester --version deploy-test-1 > "$tmp/out6" 2>&1 || { cat "$tmp/out6"; fail "--version deploy exited non-zero"; }
expect_content "$tmp/root/home/fbl/bsky-event-ingester" new-binary "--version did not deploy"

echo "PASS: all deploy.sh tests"
