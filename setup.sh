#!/bin/sh
# One-time setup. You run this, so the secret values never pass through an assistant.
#   1. gh auth login            (needs a token that can create repositories; choose GitHub.com, HTTPS, web browser)
#   2. cd ~/AutoClaw/deploys/bidcheck-au && vercel env pull /tmp/tw-prod.env --environment production --yes
#   3. cd ~/AutoClaw/deploys/tenderwin-ingest && ./setup.sh /tmp/tw-prod.env
# Creates a PUBLIC repo (unlimited free Actions minutes; the code holds no secrets), pushes, sets 3 secrets,
# starts a first full run, and deletes the env file when it finishes (or fails).
set -e
ENVFILE="$1"; [ -f "$ENVFILE" ] || { echo "usage: ./setup.sh <env-file>"; exit 1; }
trap 'rm -f "$ENVFILE"' EXIT
REPO="loyaltyC4/tenderwin-ingest"
get() { grep -m1 "^$1=" "$ENVFILE" | cut -d= -f2- | sed 's/^"//; s/"$//'; }
FC=$(grep -h '^FIRECRAWL_KEY_NEW_' ~/AutoClaw/Shared/.secrets/keys.env | cut -d= -f2- | paste -sd, -)
for k in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY; do
  v=$(get $k); { [ -n "$v" ] && [ "$v" != "[SENSITIVE]" ]; } || { echo "$k is missing or a placeholder in $ENVFILE"; exit 1; }
done
[ -n "$FC" ] || { echo "no FIRECRAWL_KEY_NEW_* values in keys.env"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "run: gh auth login"; exit 1; }
git branch -M main
git add -A && git commit -q -m "TenderWin ingest runner" 2>/dev/null || true
if gh repo view "$REPO" >/dev/null 2>&1; then
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$REPO.git"
  git push -u origin main
else
  gh repo create "$REPO" --public --source=. --remote=origin --push
fi
get SUPABASE_URL | gh secret set SUPABASE_URL -R "$REPO"
get SUPABASE_SERVICE_ROLE_KEY | gh secret set SUPABASE_SERVICE_ROLE_KEY -R "$REPO"
printf '%s' "$FC" | gh secret set FIRECRAWL_API_KEYS -R "$REPO"
gh workflow run Ingest -R "$REPO" -f run_states=1 -f run_nsw=1
echo "done: https://github.com/$REPO/actions"
