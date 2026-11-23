#!/usr/bin/env bash
# Measure the memory of the deployment account's containers while a release runs, to show that the
# stack fits a small server. Each sample sums memory.current of every running container's cgroup,
# read directly from the kernel (exact bytes, no unit parsing). Run as root.
#
#   sample-memory.sh start <directory> <deploy-user>   sample every 2 s in the background
#   sample-memory.sh stop <directory> <limit-MiB>      stop, report peaks, fail above the limit
set -Eeuo pipefail

usage() {
  echo "Usage: sample-memory.sh start <directory> <deploy-user> | stop <directory> <limit-MiB>" >&2
  exit 2
}
[[ "$(id -u)" == 0 ]] || { echo "Run as root" >&2; exit 2; }

sample() {
  local user="$1" uid line name path bytes
  uid="$(id -u "$user")"
  (cd / && runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" aa-exec -p slk-rootless -- \
    podman --remote=false ps --format '{{.Names}}' 2> /dev/null) |
    while read -r name; do
      path="$(cd / && runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" aa-exec -p slk-rootless -- \
        podman --remote=false inspect --format '{{.State.CgroupPath}}' "$name" 2> /dev/null)" || continue
      bytes="$(cat "/sys/fs/cgroup$path/memory.current" 2> /dev/null)" || continue
      [[ "$bytes" =~ ^[0-9]+$ ]] && printf '%s %s\n' "$name" "$bytes"
    done
}

case "${1:-}" in
  start)
    [[ $# == 3 ]] || usage
    mkdir -p "$2"
    rm -f "$2"/sample-*.txt
    (
      while :; do
        sample "$3" > "$2/sample-$(date +%s%N).txt" || true
        sleep 2
      done
    ) > /dev/null 2>&1 &
    echo "$!" > "$2/sampler.pid"
    echo "Memory sampling started"
    ;;
  stop)
    [[ $# == 3 && "$3" =~ ^[0-9]+$ ]] || usage
    kill "$(cat "$2/sampler.pid")" 2> /dev/null || true
    rm -f "$2/sampler.pid"
    report="$(cat "$2"/sample-*.txt 2> /dev/null | awk '
      { peak[$1] = ($2 > peak[$1]) ? $2 : peak[$1] }
      END {
        for (name in peak) printf "| %s | %.0f MiB |\n", name, peak[name] / 1048576
      }' | sort)"
    total="$(for file in "$2"/sample-*.txt; do awk '{ sum += $2 } END { printf "%.0f\n", sum / 1048576 }' "$file"; done |
      sort -n | tail -n 1)"
    samples="$(ls "$2"/sample-*.txt 2> /dev/null | wc -l)"
    [[ "$samples" -gt 0 && -n "$report" && "${total:-0}" -gt 0 ]] ||
      { echo "ERROR: no container memory was sampled ($samples samples)" >&2; exit 1; }
    {
      echo "### Memory of the running stack ($samples samples)"
      echo
      echo "| Container | Peak |"
      echo "| --- | --- |"
      echo "$report"
      echo "| **Peak total (simultaneous)** | **$total MiB** |"
    } | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"
    echo "::notice title=Memory peaks::Peak total $total MiB over $samples samples (limit $3 MiB)"
    ((total <= $3)) || { echo "::error title=Memory limit exceeded::Peak total $total MiB exceeds $3 MiB"; exit 1; }
    ;;
  *) usage ;;
esac
