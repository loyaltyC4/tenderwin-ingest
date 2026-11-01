#!/bin/sh
# One-time setup. You run this, so the secret values never pass through an assistant.
#   1. vercel env pull /tmp/tw-prod.env --environment production --yes   (run inside ~/AutoClaw/deploys/bidcheck-au)
#   2. ./setup.sh /tmp/tw-prod.env
#   3. rm /tmp/tw-prod.env
# Creates a PUBLIC repo (unlimited free Actions minutes; the code holds no secrets), pushes, sets 3 secrets.
set -e
ENVFILE="$1"; [ -f "$ENVFILE" ] || { echo "usage: ./setup.sh <env-file>"; exit 1; }
REPO="loyaltyC4/tenderwin-ingest"
get() { grep -m1 "^$1=" "$ENVFILE" | cut -d= -f2- | sed 's/^"//; s/"$//'; }
FC=$(grep -h '^FIRECRAWL_KEY_NEW_' ~/AutoClaw/Shared/.secrets/keys.env | cut -d= -f2- | paste -sd, -)
[ -n "$(get SUPABASE_URL)" ] && [ -n "$(get SUPABASE_SERVICE_ROLE_KEY)" ] && [ -n "$FC" ] || { echo "missing a value"; exit 1; }
git init -q 2>/dev/null || true
git add -A && git commit -q -m "TenderWin ingest runner" 2>/dev/null || true
gh repo create "$REPO" --public --source=. --push
get SUPABASE_URL | gh secret set SUPABASE_URL -R "$REPO"
get SUPABASE_SERVICE_ROLE_KEY | gh secret set SUPABASE_SERVICE_ROLE_KEY -R "$REPO"
printf '%s' "$FC" | gh secret set FIRECRAWL_API_KEYS -R "$REPO"
gh workflow run Ingest -R "$REPO" -f run_states=1 -f run_nsw=1
echo "done: https://github.com/$REPO/actions"
