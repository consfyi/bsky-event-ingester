#!/usr/bin/env bash
# One-command deploy of the cons.fyi droplet services from the CI-built GitHub
# Releases (issue #7). Run on the droplet as a sudo-capable user:
#
#   deploy.sh ingester                      # latest ingester release
#   deploy.sh labeler                       # latest labeler release
#   deploy.sh ingester --version <tag>      # a specific release tag
#   deploy.sh ingester --rollback           # restore the .bak from the last deploy
#
# Safety properties (same as the manual DEPLOY.md sequence it replaces):
#   - nothing touches the live files until the artifact set is downloaded,
#     checksum-verified, and executable
#   - the running binary (and the keydates worker script, for the ingester) is
#     snapshotted to .bak before the swap
#   - the swap is install + atomic rename; there is no window where the live
#     file is missing
#
# Host specifics live here rather than in a config file because they are already
# public in bsky-labeler's DEPLOY.md; the private parts (host, SSH, sudo) stay
# out of the repo either way. Requires curl and python3 (both on the box).
#
# The DEPLOY_* overrides exist so scripts/test_deploy.sh can exercise this
# script against a fake root with no sudo, systemd, or network.
set -euo pipefail
export LC_ALL=C

API_BASE="${DEPLOY_API_BASE:-https://api.github.com}"
ROOT="${DEPLOY_ROOT:-}"
SUDO="${DEPLOY_SUDO-sudo}"
SYSTEMCTL="${DEPLOY_SYSTEMCTL:-systemctl}"
JOURNALCTL="${DEPLOY_JOURNALCTL:-journalctl}"
CURL="${DEPLOY_CURL:-curl}"
SETTLE_SECS="${DEPLOY_SETTLE_SECS:-2}"

usage() {
    echo "usage: $0 <ingester|labeler> [--version <tag>] [--rollback]" >&2
    exit 2
}

die() {
    echo "error: $*" >&2
    exit 1
}

service="${1:-}"
[ -n "$service" ] || usage
shift

version=""
rollback=0
while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            [ $# -ge 2 ] || usage
            version="$2"
            shift 2
            ;;
        --rollback)
            rollback=1
            shift
            ;;
        *) usage ;;
    esac
done

# Per-service facts. extra_* is the ingester's keydates worker script, which is
# NOT auto-updated by a git pull on the box — folding it in here is half the
# point of this script.
extra_asset=""
extra_dest=""
case "$service" in
    ingester)
        repo=consfyi/bsky-event-ingester
        unit=fbl-bsky-event-ingester
        bin_asset=bsky-event-ingester
        bin_dest="$ROOT/home/fbl/bsky-event-ingester"
        extra_asset=keydates_worker.py
        extra_dest="$ROOT/home/fbl/keydates-worker/keydates_worker.py"
        ;;
    labeler)
        repo=consfyi/bsky-labeler
        unit=fbl-bsky-labeler
        bin_asset=bsky-labeler
        bin_dest="$ROOT/home/fbl/bsky-labeler"
        ;;
    *) usage ;;
esac
# The worker script runs as fbl; ownership can only be set when running as root
# for real (the test harness runs unprivileged against a fake root).
if [ -z "$ROOT" ]; then
    extra_install_args=(-o fbl -g fbl -m 644)
else
    extra_install_args=(-m 644)
fi

run_priv() {
    if [ -n "$SUDO" ]; then "$SUDO" "$@"; else "$@"; fi
}

restart_and_verify() {
    run_priv "$SYSTEMCTL" restart "$unit"
    ok=0
    for _ in 1 2 3 4 5; do
        sleep "$SETTLE_SECS"
        if run_priv "$SYSTEMCTL" is-active --quiet "$unit"; then
            ok=1
            break
        fi
    done
    echo "--- last journal lines for $unit ---"
    run_priv "$JOURNALCTL" -n 15 -u "$unit" --no-pager || true
    [ "$ok" = 1 ] || die "$unit is not active after restart; roll back with: $0 $service --rollback"
    if [ "$service" = labeler ]; then
        health_url="${DEPLOY_HEALTH_URL:-https://bsky-labeler.cons.fyi/health}"
        if "$CURL" -fsS "$health_url" >/dev/null; then
            echo "health check OK ($health_url)"
        else
            die "health check failed ($health_url); roll back with: $0 $service --rollback"
        fi
    else
        echo "note: /health reports ingester cursor lag and may return 503 for a"
        echo "while after an ingester restart (backlog re-drain, ~30 min); the"
        echo "unit being active with a clean journal is the deploy signal here."
    fi
}

if [ "$rollback" = 1 ]; then
    [ -e "$bin_dest.bak" ] || die "no $bin_dest.bak to roll back to"
    run_priv mv -f "$bin_dest.bak" "$bin_dest"
    if [ -n "$extra_dest" ] && [ -e "$extra_dest.bak" ]; then
        run_priv mv -f "$extra_dest.bak" "$extra_dest"
    fi
    restart_and_verify
    echo "rolled back $service (the .bak was consumed; the previous deploy is gone)"
    exit 0
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Resolve the release and its asset download URLs.
if [ -n "$version" ]; then
    release_url="$API_BASE/repos/$repo/releases/tags/$version"
else
    release_url="$API_BASE/repos/$repo/releases/latest"
fi
"$CURL" -fsSL "$release_url" -o "$tmp/release.json" \
    || die "could not fetch release metadata from $release_url"
tag=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["tag_name"])' "$tmp/release.json") \
    || die "malformed release metadata"
python3 -c '
import json, sys
for a in json.load(open(sys.argv[1]))["assets"]:
    print(a["name"] + "\t" + a["browser_download_url"])
' "$tmp/release.json" > "$tmp/assets.tsv"

wanted=("$bin_asset" SHA256SUMS)
[ -n "$extra_asset" ] && wanted+=("$extra_asset")
for name in "${wanted[@]}"; do
    url=$(awk -F'\t' -v n="$name" '$1 == n { print $2 }' "$tmp/assets.tsv")
    [ -n "$url" ] || die "release $tag has no asset named $name"
    "$CURL" -fsSL "$url" -o "$tmp/$name" || die "download of $name failed"
done

# Verify checksums, and verify that every file we are about to install was
# actually covered by the manifest (--ignore-missing alone would let an
# unlisted file through unchecked).
(cd "$tmp" && sha256sum -c --ignore-missing SHA256SUMS > check.out) \
    || die "checksum verification failed for release $tag"
for name in "${wanted[@]}"; do
    [ "$name" = SHA256SUMS ] && continue
    grep -q "^$name: OK$" "$tmp/check.out" || die "$name is not covered by SHA256SUMS"
done

chmod +x "$tmp/$bin_asset"
[ -x "$tmp/$bin_asset" ] || die "downloaded $bin_asset is not executable"

# Snapshot, then swap atomically (install + rename, no rm window).
if [ -e "$bin_dest" ]; then
    run_priv cp -p "$bin_dest" "$bin_dest.bak"
fi
run_priv install -m755 "$tmp/$bin_asset" "$bin_dest.new"
run_priv mv -f "$bin_dest.new" "$bin_dest"
if [ -n "$extra_dest" ]; then
    if [ -e "$extra_dest" ]; then
        run_priv cp -p "$extra_dest" "$extra_dest.bak"
    fi
    run_priv install "${extra_install_args[@]}" "$tmp/$extra_asset" "$extra_dest.new"
    run_priv mv -f "$extra_dest.new" "$extra_dest"
fi

restart_and_verify
echo "deployed $tag to $bin_dest"
echo "rollback: $0 $service --rollback"
