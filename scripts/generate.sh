#!/usr/bin/env bash
# Wrapping everything in a subshell means `exit` only kills the subshell,
# not the caller's shell — safe to run as `bash generate.sh` or `source generate.sh`.
(
set -eo pipefail

# Load login profile to get the full PATH and environment (needed when run
# non-interactively via cron/systemd where the shell is not a login shell)
# shellcheck disable=SC1090,SC1091
for _profile in "$HOME/.bash_profile" "$HOME/.profile"; do
  [[ -f "$_profile" ]] && source "$_profile" && break
done
unset _profile

# Resolve DIGEST_DIR to the directory containing this script if not already set
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIGEST_DIR="${DIGEST_DIR:-$(dirname "$SCRIPT_DIR")}"

# Load environment variables from .env (overrides profile values where set)
ENV_FILE="${DIGEST_DIR}/.env"
if [[ -f "$ENV_FILE" ]]; then
  # Strip Windows CRLF line endings before sourcing; set -a auto-exports all variables
  # shellcheck disable=SC1090
  set -a; source <(sed 's/\r//' "$ENV_FILE"); set +a
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

# ---------------------------------------------------------------------------
# Determine which agent to use
# ---------------------------------------------------------------------------
# DIGEST_AGENT env var: gemini | claude | codex | deepseek | auto (default)
# "auto" rotates daily based on day-of-month modulo 4:
#   0 → gemini, 1 → claude, 2 → codex, 3 → deepseek
DIGEST_AGENT="${DIGEST_AGENT:-auto}"

if [[ "$DIGEST_AGENT" == "auto" ]]; then
  AGENTS=("gemini" "claude" "codex" "deepseek")
  DIGEST_AGENT="${AGENTS[$(( RANDOM % 4 ))]}"
  log "Randomly selected agent: ${DIGEST_AGENT}"
else
  log "Using configured agent: ${DIGEST_AGENT}"
fi
export DIGEST_AGENT

# ---------------------------------------------------------------------------
# Shared retry / timeout settings
# ---------------------------------------------------------------------------
AGENT_TIMEOUT="${AGENT_TIMEOUT:-1200}"       # 20 minutes per attempt
AGENT_RETRIES="${AGENT_RETRIES:-2}"          # total attempts (1 = no retry)
AGENT_RETRY_DELAY="${AGENT_RETRY_DELAY:-30}" # seconds between attempts

# Truncate RAW_OUTPUT before each run
> "$RAW_OUTPUT"

AGENT_SUCCESS=false

for attempt in $(seq 1 "$AGENT_RETRIES"); do
  log "Attempt ${attempt}/${AGENT_RETRIES}: calling agent '${DIGEST_AGENT}' (timeout: ${AGENT_TIMEOUT}s)..."
  log "────────────────────────────────────────────────────────"

  EXIT_CODE=0

  # ── Gemini CLI ────────────────────────────────────────────────────────────
  if [[ "$DIGEST_AGENT" == "gemini" ]]; then
    GEMINI_MODEL="${GEMINI_MODEL:-auto}"
    export DIGEST_MODEL="$GEMINI_MODEL"
    log "Gemini model: ${GEMINI_MODEL}"

    GEMINI_STDOUT_TMP=$(mktemp /tmp/gemini-stdout-XXXXXX)
    GEMINI_STDERR_TMP=$(mktemp /tmp/gemini-stderr-XXXXXX)

    # Tail stderr live so Gemini's tool-call activity is visible in the log
    tail -f "$GEMINI_STDERR_TMP" >&2 &
    GEMINI_TAIL_PID=$!

    timeout "$AGENT_TIMEOUT" gemini \
        --model "$GEMINI_MODEL" \
        --output-format stream-json \
        -p "$(cat "$PROMPT_TODAY")" \
        < /dev/null \
        > "$GEMINI_STDOUT_TMP" \
        2> "$GEMINI_STDERR_TMP" || EXIT_CODE=$?

    kill -9 "$GEMINI_TAIL_PID" 2>/dev/null
    wait "$GEMINI_TAIL_PID" 2>/dev/null || true

    cat "$GEMINI_STDERR_TMP" >> "$LOG_FILE"
    cp "$GEMINI_STDOUT_TMP" "$RAW_OUTPUT"
    rm -f "$GEMINI_STDOUT_TMP" "$GEMINI_STDERR_TMP"

  # ── Claude Code CLI ───────────────────────────────────────────────────────
  elif [[ "$DIGEST_AGENT" == "claude" ]]; then
    # Substitute env vars into the MCP config template
    CLAUDE_MCP_RUNTIME="/tmp/claude-mcp.json"
    envsubst '${HISTORANK_MCP_URL} ${WAVESPEED_API_KEY} ${WAVESPEED_MODEL} ${DIGEST_DIR}' \
        < "${DIGEST_DIR}/agent-config/claude-mcp-template.json" \
        > "$CLAUDE_MCP_RUNTIME"

    log "Claude Code MCP config written to ${CLAUDE_MCP_RUNTIME}"


    # Write a temp script so we avoid quoting issues with large prompt content.
    # Paths are passed via exported env vars; single-quoted heredoc prevents
    # expansion at write time — the script reads the files when it executes.
    # Write a temp script so we avoid quoting issues with large prompt content.
    # Paths are passed via exported env vars; single-quoted heredoc prevents
    # expansion at write time — the script reads the files when it executes.
    CLAUDE_SCRIPT=$(mktemp /tmp/claude-run-XXXXXX.sh)
    export _CLAUDE_MCP="$CLAUDE_MCP_RUNTIME"
    export _CLAUDE_SYSTEM="$DIGEST_DIR/AGENT.md"
    export _CLAUDE_PROMPT="$PROMPT_TODAY"
    export _CLAUDE_BIN
    # Prefer /usr/local/bin/claude (accessible to all users) over a root-home install
    if [[ -x /usr/local/bin/claude ]]; then
      _CLAUDE_BIN=/usr/local/bin/claude
    else
      _CLAUDE_BIN="$(command -v claude)"
    fi
    # When su is used, HOME stays as root's home (su -p preserves env).
    # Resolve the target user's real home now so the script can override it.
    if [[ -n "${CLAUDE_USER:-}" ]]; then
      export _CLAUDE_HOME
      _CLAUDE_HOME="$(getent passwd "$CLAUDE_USER" | cut -d: -f6)"
    fi
    cat > "$CLAUDE_SCRIPT" <<'CLAUDE_EOF'
#!/bin/bash
# Fix HOME/USER so Claude doesn't detect a root environment
export HOME="$_CLAUDE_HOME"
export USER="$(id -un)"
exec "$_CLAUDE_BIN" \
    --output-format stream-json \
    --verbose \
    --mcp-config "$_CLAUDE_MCP" \
    --dangerously-skip-permissions \
    --system-prompt "$(cat "$_CLAUDE_SYSTEM")" \
    -p "$(cat "$_CLAUDE_PROMPT")"
CLAUDE_EOF
    chmod +x "$CLAUDE_SCRIPT"

    CLAUDE_STDOUT_TMP=$(mktemp /tmp/claude-stdout-XXXXXX)
    CLAUDE_STDERR_TMP=$(mktemp /tmp/claude-stderr-XXXXXX)

    if [[ -n "${CLAUDE_USER:-}" ]]; then
      log "Running Claude as user '${CLAUDE_USER}' (home: ${_CLAUDE_HOME})..."
      chown "$CLAUDE_USER" "$CLAUDE_SCRIPT" "$CLAUDE_MCP_RUNTIME" \
          "$CLAUDE_STDOUT_TMP" "$CLAUDE_STDERR_TMP" 2>/dev/null || true
    fi

    # Tail both stdout (stream-json events) and stderr live to terminal
    tail -f "$CLAUDE_STDOUT_TMP" >&2 &
    TAIL_OUT_PID=$!
    tail -f "$CLAUDE_STDERR_TMP" >&2 &
    TAIL_ERR_PID=$!

    if [[ -n "${CLAUDE_USER:-}" ]]; then
      if command -v gosu &>/dev/null; then
        _RUN_AS="gosu $CLAUDE_USER"
      else
        _RUN_AS="sudo -u $CLAUDE_USER"
      fi
      timeout "$AGENT_TIMEOUT" $_RUN_AS bash "$CLAUDE_SCRIPT" \
          < /dev/null \
          > "$CLAUDE_STDOUT_TMP" \
          2> "$CLAUDE_STDERR_TMP" || EXIT_CODE=$?
    else
      timeout "$AGENT_TIMEOUT" bash "$CLAUDE_SCRIPT" \
          < /dev/null \
          > "$CLAUDE_STDOUT_TMP" \
          2> "$CLAUDE_STDERR_TMP" || EXIT_CODE=$?
    fi

    kill -9 "$TAIL_OUT_PID" "$TAIL_ERR_PID" 2>/dev/null
    wait "$TAIL_OUT_PID" "$TAIL_ERR_PID" 2>/dev/null || true

    # Append stderr to log (errors/warnings from Claude)
    cat "$CLAUDE_STDERR_TMP" >> "$LOG_FILE"
    cp "$CLAUDE_STDOUT_TMP" "$RAW_OUTPUT"
    rm -f "$CLAUDE_STDOUT_TMP" "$CLAUDE_STDERR_TMP"
    rm -f "$CLAUDE_SCRIPT"
    unset _CLAUDE_MCP _CLAUDE_SYSTEM _CLAUDE_PROMPT _CLAUDE_HOME

  # ── OpenAI Codex CLI ──────────────────────────────────────────────────────
  elif [[ "$DIGEST_AGENT" == "codex" ]]; then
    export CODEX_MODEL="${CODEX_MODEL:-gpt-5.4-mini}"
    export DIGEST_MODEL="$CODEX_MODEL"

    # Substitute env vars into the TOML config template and write to the
    # location codex reads automatically: ~/.codex/config.toml
    mkdir -p "$HOME/.codex"
    envsubst '${CODEX_MODEL} ${HISTORANK_MCP_URL} ${WAVESPEED_API_KEY} ${WAVESPEED_MODEL} ${DIGEST_DIR} ${PATH} ${NODE_PATH}' \
        < "${DIGEST_DIR}/agent-config/codex-config-template.yaml" \
        > "$HOME/.codex/config.yaml"

    log "Codex config written to ${HOME}/.codex/config.yaml"

    # codex exec runs non-interactively.
    # There is no --instructions flag; prepend AGENT.md to the prompt instead.
    # --json emits JSONL which postprocess.js handles via its text fallback.
    # --ephemeral avoids persisting session state between runs.
    CODEX_PROMPT="$(cat "${DIGEST_DIR}/AGENT.md")

---

$(cat "$PROMPT_TODAY")"

    CODEX_STDOUT_TMP=$(mktemp /tmp/codex-stdout-XXXXXX)
    CODEX_STDERR_TMP=$(mktemp /tmp/codex-stderr-XXXXXX)

    tail -f "$CODEX_STDOUT_TMP" >&2 &
    CODEX_TAIL_OUT_PID=$!
    tail -f "$CODEX_STDERR_TMP" >&2 &
    CODEX_TAIL_ERR_PID=$!

    timeout "$AGENT_TIMEOUT" codex exec \
        --full-auto \
        --json \
        --ephemeral \
        "$CODEX_PROMPT" \
        > "$CODEX_STDOUT_TMP" \
        2> "$CODEX_STDERR_TMP" || EXIT_CODE=$?

    kill -9 "$CODEX_TAIL_OUT_PID" "$CODEX_TAIL_ERR_PID" 2>/dev/null
    wait "$CODEX_TAIL_OUT_PID" "$CODEX_TAIL_ERR_PID" 2>/dev/null || true

    cat "$CODEX_STDERR_TMP" >> "$LOG_FILE"
    cp "$CODEX_STDOUT_TMP" "$RAW_OUTPUT"
    rm -f "$CODEX_STDOUT_TMP" "$CODEX_STDERR_TMP"

  # ── DeepSeek (via run-agent.js) ───────────────────────────────────────────
  elif [[ "$DIGEST_AGENT" == "deepseek" ]]; then
    export DIGEST_MODEL="${DEEPSEEK_MODEL:-deepseek-chat}"

    DEEPSEEK_STDOUT_TMP=$(mktemp /tmp/deepseek-stdout-XXXXXX)
    DEEPSEEK_STDERR_TMP=$(mktemp /tmp/deepseek-stderr-XXXXXX)

    tail -f "$DEEPSEEK_STDERR_TMP" >&2 &
    DEEPSEEK_TAIL_PID=$!

    timeout "$AGENT_TIMEOUT" node "${DIGEST_DIR}/scripts/run-agent.js" \
        --agent deepseek \
        --prompt-file "$PROMPT_TODAY" \
        < /dev/null \
        > "$DEEPSEEK_STDOUT_TMP" \
        2> "$DEEPSEEK_STDERR_TMP" || EXIT_CODE=$?

    kill -9 "$DEEPSEEK_TAIL_PID" 2>/dev/null
    wait "$DEEPSEEK_TAIL_PID" 2>/dev/null || true

    cat "$DEEPSEEK_STDERR_TMP" >> "$LOG_FILE"
    cp "$DEEPSEEK_STDOUT_TMP" "$RAW_OUTPUT"
    rm -f "$DEEPSEEK_STDOUT_TMP" "$DEEPSEEK_STDERR_TMP"

  else
    log "ERROR: Unknown DIGEST_AGENT '${DIGEST_AGENT}'. Valid: gemini | claude | codex | deepseek | auto"
    exit 1
  fi

  log "────────────────────────────────────────────────────────"

  if [[ $EXIT_CODE -eq 0 ]]; then
    AGENT_SUCCESS=true
    break
  elif [[ $EXIT_CODE -eq 124 ]]; then
    log "ERROR: Agent timed out after ${AGENT_TIMEOUT}s — not retrying."
    log "Raw output (first 500 bytes): $(head -c 500 "$RAW_OUTPUT" 2>/dev/null || echo '(empty)')"
    break
  else
    log "ERROR: Agent exited with status ${EXIT_CODE}."
    log "Raw output (first 500 bytes): $(head -c 500 "$RAW_OUTPUT" 2>/dev/null || echo '(empty)')"
    if [[ $attempt -lt $AGENT_RETRIES ]]; then
      log "Retrying in ${AGENT_RETRY_DELAY}s..."
      sleep "$AGENT_RETRY_DELAY"
    fi
  fi
done

if [[ $AGENT_SUCCESS != true ]]; then
  log "ERROR: All ${AGENT_RETRIES} attempt(s) failed. Aborting."
  exit 1
fi

log "────────────────────────────────────────────────────────"
log "Agent finished. Raw output: ${RAW_OUTPUT} ($(wc -c < "$RAW_OUTPUT") bytes)"
log "Running postprocess.js..."

if ! node "${DIGEST_DIR}/scripts/postprocess.js"; then
  log "ERROR: postprocess.js exited with non-zero status. Aborting."
  exit 1
fi

log "=== HistoRank digest generation completed successfully for ${TODAY} ==="
)
