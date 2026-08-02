#!/bin/bash
#
# Release script for opencode-supermemory
#
# Usage:
#   ./scripts/release.sh [patch|minor|major]
#
# Examples:
#   ./scripts/release.sh patch   # 0.1.4 → 0.1.5
#   ./scripts/release.sh minor   # 0.1.4 → 0.2.0
#   ./scripts/release.sh major   # 0.1.4 → 1.0.0
#
# After running, push to trigger the GitHub Actions release workflow:
#   git push && git push --tags
#
# Prerequisites:
#   - jq installed
#   - NPM_TOKEN secret configured in GitHub repo settings
#
set -e

BUMP_TYPE="${1:-patch}"

if [[ ! "$BUMP_TYPE" =~ ^(patch|minor|major)$ ]]; then
  echo "usage: ./scripts/release.sh [patch|minor|major]"
  exit 1
fi

CURRENT_VERSION=$(jq -r .version package.json)
echo "current version: $CURRENT_VERSION"

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"
case "$BUMP_TYPE" in
  major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
  patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
esac

echo "new version: $NEW_VERSION"

jq ".version = \"$NEW_VERSION\"" package.json > package.json.tmp && mv package.json.tmp package.json

# Keep src/version.ts (PLUGIN_VERSION) in sync with the bumped package.json so
# they cannot drift.
node scripts/sync-version.mjs

git add package.json src/version.ts
git commit -m "v$NEW_VERSION"
git tag "v$NEW_VERSION"

echo ""
echo "created commit and tag v$NEW_VERSION"
echo "run 'git push && git push --tags' to trigger release"
