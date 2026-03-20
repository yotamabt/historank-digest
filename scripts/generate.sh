#!/usr/bin/env bash
set -eo pipefail

# Resolve DIGEST_DIR to the directory containing this script if not already set
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIGEST_DIR="${DIGEST_DIR:-$(dirname "$SCRIPT_DIR")}"

# Load environment variables
ENV_FILE="${DIGEST_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  # Strip Windows CRLF line endings before sourcing
  # shellcheck disable=SC1090
  source <(sed 's/\r//' "$ENV_FILE")
else
  echo "[generate.sh] WARNING: .env file not found at ${ENV_FILE}" >&2
fi

# Defaults that depend on env vars (may have been set in .env)
LOG_DIR="${LOG_DIR:-${DIGEST_DIR}/logs}"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

LOG_FILE="${LOG_DIR}/digest.log"

# Accept an optional date argument (YYYY-MM-DD). Defaults to today (UTC).
if [[ -n "$1" ]]; then
  if [[ ! "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    echo "Usage: generate.sh [YYYY-MM-DD]" >&2
    exit 1
  fi
  TODAY="$1"
else
  TODAY="$(date -u +%Y-%m-%d)"
fi

PROMPT_TEMPLATE="${DIGEST_DIR}/prompts/digest.md"
PROMPT_TODAY="/tmp/digest-prompt-today.md"
RAW_OUTPUT="/tmp/raw-digest.json"

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*" | tee -a "$LOG_FILE"
}

log "=== HistoRank digest generation started for ${TODAY} ==="

# Substitute the {DATE} placeholder with today's date
sed "s/{DATE}/${TODAY}/g" "$PROMPT_TEMPLATE" > "$PROMPT_TODAY"

log "Prompt written to ${PROMPT_TODAY}"
GEMINI_MODEL="${GEMINI_MODEL:-auto}"
GEMINI_TIMEOUT="${GEMINI_TIMEOUT:-1200}"  # 20 minutes; override via env if needed
log "Calling Gemini CLI (model: ${GEMINI_MODEL}, timeout: ${GEMINI_TIMEOUT}s) — streaming output below..."
log "────────────────────────────────────────────────────────"

# --output-format stream-json emits one JSON event per line in real time,
# including tool calls, so activity is visible while the model works.
# stderr  → shown on terminal AND appended to log
# stdout  → shown on terminal AND captured to RAW_OUTPUT via tee
# timeout sends SIGTERM after GEMINI_TIMEOUT seconds (exit 124 = timed out)
if ! timeout "$GEMINI_TIMEOUT" gemini --model "$GEMINI_MODEL" --output-format stream-json \
      -p "$(cat "$PROMPT_TODAY")" \
      2> >(tee -a "$LOG_FILE" >&2) \
      | tee "$RAW_OUTPUT" | tee -a "$LOG_FILE"; then
  EXIT_CODE=$?
  if [[ $EXIT_CODE -eq 124 ]]; then
    log "ERROR: Gemini CLI timed out after ${GEMINI_TIMEOUT}s. Aborting."
  else
    log "ERROR: Gemini CLI exited with status ${EXIT_CODE}. Aborting."
  fi
  exit 1
fi

log "────────────────────────────────────────────────────────"
log "Gemini CLI finished. Raw output: ${RAW_OUTPUT} ($(wc -c < "$RAW_OUTPUT") bytes)"
log "Running postprocess.js..."

if ! node "${DIGEST_DIR}/scripts/postprocess.js"; then
  log "ERROR: postprocess.js exited with non-zero status. Aborting."
  exit 1
fi

log "=== HistoRank digest generation completed successfully for ${TODAY} ==="
