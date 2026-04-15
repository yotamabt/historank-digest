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

# nvm is typically loaded in .bashrc (not .bash_profile), so source it explicitly
# when running non-interactively so that node/codex/claude are on PATH
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
# shellcheck disable=SC1091
[[ -f "$NVM_DIR/nvm.sh" ]] && source "$NVM_DIR/nvm.sh"

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
# Determine which agent to use + fallback chain
# ---------------------------------------------------------------------------
# DIGEST_AGENT: gemini | claude | codex | deepseek | auto (default)
# DIGEST_AGENT_FALLBACKS: space-separated list of agents to try if primary fails
#   e.g. DIGEST_AGENT_FALLBACKS="gemini claude" tries gemini then claude
#   Defaults to trying all other agents in a fixed order.
DIGEST_AGENT="${DIGEST_AGENT:-auto}"

ALL_AGENTS=("gemini" "claude" "codex" "deepseek")

if [[ "$DIGEST_AGENT" == "auto" ]]; then
  DIGEST_AGENT="${ALL_AGENTS[$(( RANDOM % ${#ALL_AGENTS[@]} ))]}"
  log "Randomly selected agent: ${DIGEST_AGENT}"
else
  log "Using configured agent: ${DIGEST_AGENT}"
fi

# Build the agent chain: primary first, then fallbacks (skip duplicates)
if [[ -n "${DIGEST_AGENT_FALLBACKS:-}" ]]; then
  read -ra _FALLBACKS <<< "$DIGEST_AGENT_FALLBACKS"
else
  # Default fallback: all other agents in fixed order
  _FALLBACKS=()
  for _a in "${ALL_AGENTS[@]}"; do
    [[ "$_a" != "$DIGEST_AGENT" ]] && _FALLBACKS+=("$_a")
  done
fi
AGENT_CHAIN=("$DIGEST_AGENT")
for _a in "${_FALLBACKS[@]}"; do
  [[ "$_a" != "$DIGEST_AGENT" ]] && AGENT_CHAIN+=("$_a")
done
unset _FALLBACKS _a

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

for DIGEST_AGENT in "${AGENT_CHAIN[@]}"; do
  export DIGEST_AGENT
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
    envsubst '${HISTORANK_MCP_URL} ${WAVESPEED_API_KEY} ${WAVESPEED_MODEL} ${DIGEST_DIR} ${PATH} ${NODE_PATH}' \
        < "${DIGEST_DIR}/agent-config/claude-mcp-template.json" \
        > "$CLAUDE_MCP_RUNTIME"

    log "Claude Code MCP config written to ${CLAUDE_MCP_RUNTIME}"

    # Verify wavespeed MCP subprocess starts correctly before handing off to claude
    _WS_TEST_ERR=$(WAVESPEED_API_KEY="$WAVESPEED_API_KEY" WAVESPEED_MODEL="$WAVESPEED_MODEL" \
        timeout 5 node "${DIGEST_DIR}/wavespeed-mcp/index.js" < /dev/null 2>&1 || true)
    if echo "$_WS_TEST_ERR" | grep -q "ERROR:"; then
      log "ERROR: wavespeed MCP subprocess failed pre-flight check: ${_WS_TEST_ERR}"
      exit 1
    fi
    log "Wavespeed MCP pre-flight: OK (key present=$([ -n "${WAVESPEED_API_KEY:-}" ] && echo yes || echo NO))"
    unset _WS_TEST_ERR


    # Write a temp script so we avoid quoting issues with large prompt content.
    # Paths are passed via exported env vars; single-quoted heredoc prevents
    # expansion at write time — the script reads the files when it executes.
    # Write a temp script so we avoid quoting issues with large prompt content.
    # Paths are passed via exported env vars; single-quoted heredoc prevents
    # expansion at write time — the script reads the files when it executes.
    CLAUDE_SCRIPT=$(mktemp /tmp/claude-run-XXXXXX.sh)
    export _CLAUDE_MCP="$CLAUDE_MCP_RUNTIME"
    export _CLAUDE_SYSTEM="$DIGEST_DIR/AGENT-claude.md"
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

    # Sanity-check required variables before writing the config
    [[ -z "${WAVESPEED_API_KEY:-}" ]] && { log "ERROR: WAVESPEED_API_KEY is not set — wavespeed MCP will fail to start."; exit 1; }
    [[ -z "${HISTORANK_MCP_URL:-}" ]] && { log "ERROR: HISTORANK_MCP_URL is not set."; exit 1; }

    mkdir -p "$HOME/.codex"
    envsubst '${CODEX_MODEL} ${HISTORANK_MCP_URL} ${WAVESPEED_API_KEY} ${WAVESPEED_MODEL} ${DIGEST_DIR} ${PATH} ${NODE_PATH}' \
        < "${DIGEST_DIR}/agent-config/codex-config-template.yaml" \
        > "$HOME/.codex/config.yaml"

    log "Codex config written to ${HOME}/.codex/config.yaml"
    log "Wavespeed MCP: key present=$([ -n "${WAVESPEED_API_KEY:-}" ] && echo yes || echo NO), path=${DIGEST_DIR}/wavespeed-mcp/index.js"

    # Verify the wavespeed MCP subprocess starts correctly before handing off to codex
    _WS_TEST_ERR=$(WAVESPEED_API_KEY="$WAVESPEED_API_KEY" WAVESPEED_MODEL="$WAVESPEED_MODEL" \
        timeout 5 node "${DIGEST_DIR}/wavespeed-mcp/index.js" < /dev/null 2>&1 || true)
    if echo "$_WS_TEST_ERR" | grep -q "ERROR:"; then
      log "ERROR: wavespeed MCP subprocess failed pre-flight check: ${_WS_TEST_ERR}"
      exit 1
    fi
    log "Wavespeed MCP pre-flight: OK"
    unset _WS_TEST_ERR

    # Resolve codex binary: explicit env var > /usr/local/bin > PATH
    if [[ -n "${CODEX_BIN:-}" && -x "$CODEX_BIN" ]]; then
      _CODEX_BIN="$CODEX_BIN"
    elif [[ -x /usr/local/bin/codex ]]; then
      _CODEX_BIN=/usr/local/bin/codex
    else
      _CODEX_BIN="$(command -v codex 2>/dev/null || true)"
    fi
    log "Using codex binary: ${_CODEX_BIN}"

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

    timeout "$AGENT_TIMEOUT" "$_CODEX_BIN" exec \
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
    break 2
  elif [[ $EXIT_CODE -eq 124 ]]; then
    log "ERROR: Agent '${DIGEST_AGENT}' timed out after ${AGENT_TIMEOUT}s."
    log "Raw output (first 500 bytes): $(head -c 500 "$RAW_OUTPUT" 2>/dev/null || echo '(empty)')"
    break  # timeout — don't retry same agent, try next in chain
  else
    log "ERROR: Agent '${DIGEST_AGENT}' exited with status ${EXIT_CODE}."
    log "Raw output (first 500 bytes): $(head -c 500 "$RAW_OUTPUT" 2>/dev/null || echo '(empty)')"
    if [[ $attempt -lt $AGENT_RETRIES ]]; then
      log "Retrying in ${AGENT_RETRY_DELAY}s..."
      sleep "$AGENT_RETRY_DELAY"
    fi
  fi
done
  log "ERROR: All ${AGENT_RETRIES} attempt(s) with agent '${DIGEST_AGENT}' failed — trying next agent in chain."
done

if [[ $AGENT_SUCCESS != true ]]; then
  log "ERROR: All agents in chain (${AGENT_CHAIN[*]}) failed. Aborting."
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
