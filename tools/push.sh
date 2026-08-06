#!/usr/bin/env bash
#
# Reliable push into an intermittently-throttled network.
#
# THE ACTUAL PROBLEM
# ------------------
# Pushes here failed with two different-looking errors:
#
#   fatal: ... GnuTLS, handshake failed: The TLS connection was
#          non-properly terminated.
#   fatal: ... The requested URL returned error: 403
#
# Both are the SAME cause. Measured directly:
#
#   DNS            github.com -> 20.29.134.23      OK
#   TCP :443       connect                          OK
#   TLS            "Client hello" sent, then silence, then timeout
#   npmjs.org      HTTP 200 in 0.056s               OK
#   github.com     6 consecutive tries: stall, stall, 200, 200, 403, stall
#
# So: the network is healthy, DNS is healthy, TCP is healthy, and one specific
# destination is being throttled about half the time. When the throttle drops
# the connection during the handshake, git reports a TLS error; when it lets
# the connection through but rejects the request, git reports 403. Neither is
# a certificate problem, a credential problem, or a GnuTLS bug.
#
# WHAT DOES NOT FIX IT
#   - Switching to SSH. Port 22 crosses the same egress filter, and the
#     sandbox has no key registered with GitHub.
#   - Forcing a TLS version, or updating CA certificates. The handshake is
#     being dropped in transit, not rejected. `curl` with OpenSSL stalls
#     identically to git with GnuTLS, which rules the TLS library out.
#   - Blind retry loops. That is what I was doing, and it burned minutes
#     because each failed attempt waits out a 30s connect timeout first.
#
# WHAT DOES
#   Probe cheaply for a window in which GitHub is responding, and only then
#   spend a push on it. A 5-second probe costs almost nothing; a doomed push
#   costs 30 seconds of timeout.
#
# Usage:  tools/push.sh [branch]

set -uo pipefail

BRANCH="${1:-main}"
MAX_ATTEMPTS=25
PROBE_TIMEOUT=5
PUSH_TIMEOUT=90

# Redact any token that appears in git's output. The remote URL may embed a
# PAT, and it must never reach a log or a terminal transcript.
redact() { sed -E 's/(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]+/[REDACTED]/g'; }

if git diff --quiet && git diff --cached --quiet && \
   [ -z "$(git log "origin/${BRANCH}..HEAD" --oneline 2>/dev/null)" ]; then
  echo "Nothing to push — local and origin/${BRANCH} agree."
  exit 0
fi

pending=$(git log "origin/${BRANCH}..HEAD" --oneline 2>/dev/null | wc -l | tr -d ' ')
echo "Pushing ${pending} commit(s) to origin/${BRANCH}."

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  # Cheap reachability probe. Any HTTP response at all means the throttle is
  # currently letting us through; the status code itself does not matter,
  # because an unauthenticated GET is expected to be rejected.
  code=$(curl -s -o /dev/null -w '%{http_code}' \
           --max-time "$PROBE_TIMEOUT" https://github.com/ 2>/dev/null)

  if [ "$code" = "000" ] || [ -z "$code" ]; then
    printf '  attempt %2d: github unreachable, waiting…\n' "$attempt"
    sleep 5
    continue
  fi

  printf '  attempt %2d: github responding (%s), pushing… ' "$attempt" "$code"
  out=$(timeout "$PUSH_TIMEOUT" git push origin "$BRANCH" 2>&1 | redact)

  if printf '%s' "$out" | grep -qE '\-> +'"$BRANCH"'|Everything up-to-date'; then
    echo "OK"
    printf '%s\n' "$out" | sed 's/^/    /'
    exit 0
  fi

  echo "failed"
  printf '%s\n' "$out" | tail -1 | sed 's/^/    /'
  sleep 4
done

echo
echo "Could not push after ${MAX_ATTEMPTS} attempts. The commits are safe in the"
echo "local repository; run this script again, or push from a machine outside"
echo "this sandbox:  git push origin ${BRANCH}"
exit 1
