#!/usr/bin/env bash
# Puts a signed feed on the update-feed branch, as the commit after the one it was made from:
#
#   scripts/native-apps/promote-publish.sh <folder promote-prepare.sh filled> <feed.json> <message>
#
# The push is never forced. When another change landed since, it is refused, and the promotion has to be
# run again on the feed that is there now.
set -euo pipefail

prepared=$1
feed=$2
message=$3
remote=${FEED_REMOTE:-https://github.com/$GITHUB_REPOSITORY.git}

readme='The update feed of the EtherPK apps. The promote workflow writes it: do not edit it by hand.'
tree=$(printf '100644 blob %s\tREADME.md\n100644 blob %s\tfeed.json\n' \
    "$(git hash-object -w --stdin <<<"$readme")" "$(git hash-object -w "$feed")" | git mktree)
parent=()
if [ -f "$prepared/base" ]; then parent=(-p "$(cat "$prepared/base")"); fi
commit=$(git commit-tree "$tree" "${parent[@]}" -m "$message")
git push "$remote" "$commit:refs/heads/update-feed"
