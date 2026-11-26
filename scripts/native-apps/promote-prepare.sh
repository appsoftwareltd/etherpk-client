#!/usr/bin/env bash
# Gathers what a change to the update feed is made from, and refuses what must not be offered:
#
#   ACTION=promote|pause|renew VERSION=x.y.z scripts/native-apps/promote-prepare.sh <folder>
#
# Into <folder> go `previous.json` (the feed there is now) and `base` (its commit), both missing when there
# is no feed, and for a promotion `assets/`, the release's installers. Each of those must be in the
# release's SHA256SUMS and have been built by this repository's own workflow, on GitHub's machines, from
# the commit the release names. It needs gh (GH_TOKEN), git and GITHUB_REPOSITORY, and no secret.
set -euo pipefail

out=$1
mkdir -p "$out"
remote=${FEED_REMOTE:-https://github.com/$GITHUB_REPOSITORY.git}

fail() { echo "::error::$1"; exit 1; }

# 2 is "no such branch". Anything else is a failure to ask, which must not be read as that.
status=0
git ls-remote --exit-code "$remote" refs/heads/update-feed > "$out/remote" || status=$?
case $status in
    0)
        base=$(cut -f1 "$out/remote")
        git fetch --quiet --depth 1 "$remote" "$base"
        git show "$base:feed.json" > "$out/previous.json"
        echo "$base" > "$out/base"
        ;;
    2) echo 'There is no update-feed branch.' ;;
    *) exit "$status" ;;
esac

[ "$ACTION" = promote ] || exit 0
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "\"$VERSION\" is not a version."
draft=$(gh release view "v$VERSION" --repo "$GITHUB_REPOSITORY" --json isDraft --jq .isDraft) || fail "There is no release v$VERSION."
[ "$draft" = false ] || fail "The release v$VERSION is a draft."
commit=$(gh api "repos/$GITHUB_REPOSITORY/commits/v$VERSION" --jq .sha)

mkdir -p "$out/assets"
gh release download "v$VERSION" --repo "$GITHUB_REPOSITORY" --dir "$out/assets" --pattern 'EtherPK-*' --pattern SHA256SUMS
(cd "$out/assets" && sha256sum --check --strict SHA256SUMS)
for file in "$out"/assets/EtherPK-*; do
    grep -q "  $(basename "$file")\$" "$out/assets/SHA256SUMS" || fail "$(basename "$file") is not in SHA256SUMS."
    gh attestation verify "$file" --repo "$GITHUB_REPOSITORY" \
        --signer-workflow "$GITHUB_REPOSITORY/.github/workflows/build.yaml" \
        --source-ref refs/heads/main --source-digest "$commit" --deny-self-hosted-runners
done
