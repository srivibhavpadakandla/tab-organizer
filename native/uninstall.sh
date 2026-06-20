#!/bin/bash
# Removes the Tab Organizer native-messaging host registration.
set -euo pipefail
HOST_NAME="com.tab_organizer.claude"
removed=0
for BASE in \
  "$HOME/Library/Application Support/Google/Chrome" \
  "$HOME/Library/Application Support/Google/Chrome Beta" \
  "$HOME/Library/Application Support/Google/Chrome Canary" \
  "$HOME/Library/Application Support/Chromium" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser" \
  "$HOME/Library/Application Support/Microsoft Edge"; do
  F="$BASE/NativeMessagingHosts/$HOST_NAME.json"
  if [ -f "$F" ]; then rm -f "$F"; echo "removed -> $F"; removed=$((removed + 1)); fi
done
echo "Done. Removed $removed registration(s)."
