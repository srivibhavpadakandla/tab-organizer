#!/bin/bash
# Double-click this file in Finder to connect Tab Organizer to your Claude CLI.
# (It just runs install.sh and keeps the window open so you can read the result.)
cd "$(dirname "$0")" || exit 1
echo "Connecting Tab Organizer to the Claude CLI…"
echo
bash install.sh
echo
echo "──────────────────────────────────────────────"
echo "Done. You can close this window and click \"Smart group\" in the extension."
echo "(If it still says unavailable, fully quit and reopen your browser once.)"
echo
read -n 1 -s -r -p "Press any key to close…"
