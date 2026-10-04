#!/usr/bin/env bash
# Model-check formal/Dispatcher.tla with TLC (tasks.md T021). Fails on any violation.
#
# TLA2TOOLS: path to tla2tools.jar (default: ./tla2tools.jar, fetched by CI with a pinned
# SHA-256). JAVA: java binary (default: java on PATH). TLC_HEAP: max heap (default 1g).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
jar="$(realpath "${TLA2TOOLS:-$root/tla2tools.jar}")"
java="${JAVA:-java}"
states="$root/formal/states"

if [[ ! -f "$jar" ]]; then
  echo "tlc.sh: tla2tools.jar not found at $jar (set TLA2TOOLS)" >&2
  exit 3
fi

rm -rf "$states"
trap 'rm -rf "$states"' EXIT
cd "$root/formal"
log="$(mktemp)"
set +e
"$java" "-Xmx${TLC_HEAP:-1g}" -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
  -workers auto -metadir "$states" -config Dispatcher.cfg Dispatcher.tla | tee "$log"
status=${PIPESTATUS[0]}
set -e
# TLC exits non-zero on a violation; also require its success line, so a crash or an
# unparsed config never passes.
if [[ $status -ne 0 ]] || ! grep -q 'Model checking completed. No error has been found.' "$log"; then
  rm -f "$log"
  echo "tlc.sh: model check failed (exit $status)" >&2
  exit 1
fi
rm -f "$log"
