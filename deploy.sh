#!/bin/zsh
# Publishes this folder to GitHub Pages as https://hechemti.github.io/race-live/
# Run once:  zsh "/Users/hmt/strava]/race-live/deploy.sh"
set -e
cd "${0:A:h}"
CODE="race-ge4ndxk8ny2xbothx9kd"

if [ ! -d .git ]; then
  git init -q -b main
fi
git add -A
git -c user.name="hechemti" -c user.email="hechemti@users.noreply.github.com" commit -q -m "Race Day Live tracker" || true

if ! gh repo view hechemti/race-live >/dev/null 2>&1; then
  gh repo create race-live --public --source=. --push --description "Live half-marathon tracker"
else
  git push -q -u origin main
fi
gh api -X POST repos/hechemti/race-live/pages -f "source[branch]=main" -f "source[path]=/" >/dev/null 2>&1 || true

echo "Waiting for GitHub Pages to go live (usually under 2 minutes)…"
for i in {1..40}; do
  if curl -s -o /dev/null -w "%{http_code}" https://hechemti.github.io/race-live/run.html | grep -q 200; then
    echo
    echo "LIVE."
    echo "Your phone (runner):  https://hechemti.github.io/race-live/run.html#t=$CODE"
    echo "Send to friends:      https://hechemti.github.io/race-live/#t=$CODE"
    exit 0
  fi
  printf "."; sleep 5
done
echo
echo "Pages is still building. Try the links in a minute:"
echo "Your phone (runner):  https://hechemti.github.io/race-live/run.html#t=$CODE"
echo "Send to friends:      https://hechemti.github.io/race-live/#t=$CODE"
