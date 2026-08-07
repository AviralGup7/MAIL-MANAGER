#!/bin/sh
# Answer one question: is the manifest on THIS disk mangled?
#
# The manifest has now been pasted four times with every URL rewritten as
# [https://x](https://x) -- markdown link syntax inside the JSON. That is
# almost certainly the chat client linkifying on the way out. But "almost
# certainly" has cost several rounds, and this settles it in one second
# without needing node, npm, or anything installed.
#
#   sh tools/is-my-manifest-ok.sh
set -u
MF="${1:-manifest.json}"

if [ ! -f "$MF" ]; then
  echo "No manifest.json here. Are you in the repo root?"
  exit 1
fi

if grep -q '](http' "$MF"; then
  echo
  echo "  *** YOUR manifest.json IS MANGLED ***"
  echo
  grep -n '](http' "$MF" | head
  echo
  echo "  Those are markdown links inside JSON. The file still PARSES,"
  echo "  so it looks fine, and Chrome then rejects it -- which surfaces"
  echo "  as 'Service worker registration failed. Status code: 2'."
  echo
  echo "  Fix:  git checkout manifest.json"
  echo
  exit 1
fi

echo "manifest.json on disk is clean -- no markdown mangling."
echo "The pasted copies were being linkified by the chat client, not by you."
