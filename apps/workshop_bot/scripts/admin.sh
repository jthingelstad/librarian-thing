#!/bin/bash
set -e

LABEL="com.weeklything.workshop-bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKSHOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$WORKSHOP_DIR/../.." && pwd)"
LOG_DIR="$WORKSHOP_DIR/logs"
VENV="$REPO_ROOT/.venv"

require_venv() {
    if [ ! -x "$VENV/bin/python" ]; then
        echo "Error: uv project environment not found at $VENV." >&2
        echo "  Create it with:  cd $REPO_ROOT && uv sync --locked --no-dev" >&2
        exit 1
    fi
}

status() {
    local details state pid last_exit
    if ! details="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null)"; then
        echo "workshop-bot is stopped."
        return
    fi
    state="$(printf '%s\n' "$details" | awk '$1 == "state" { print $3; exit }')"
    pid="$(printf '%s\n' "$details" | awk '$1 == "pid" { print $3; exit }')"
    if [ "$state" = "running" ] && [ -n "$pid" ]; then
        echo "workshop-bot is running (pid $pid)."
        return
    fi
    last_exit="$(printf '%s\n' "$details" | awk -F'= ' '/last exit code/ { print $2; exit }')"
    echo "workshop-bot is loaded but not running (state: ${state:-unknown}, last exit: ${last_exit:-unknown})."
}

require_running() {
    local details
    details="$(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null)" || return 1
    printf '%s\n' "$details" | grep -q 'state = running' &&
        printf '%s\n' "$details" | grep -q 'pid = '
}

stop_bot() {
    echo "==> Stopping workshop-bot..."
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    sleep 1
    status
}

start_bot() {
    if [ ! -f "$PLIST" ]; then
        echo "Error: plist not found at $PLIST"
        echo "Run '$0 install' first."
        exit 1
    fi
    echo "==> Starting workshop-bot..."
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    sleep 3
    status
    if ! require_running; then
        echo "Error: Workshop Bot failed to reach running state." >&2
        tail -n 40 "$LOG_DIR/workshop.err" >&2 || true
        exit 1
    fi
}

restart_bot() {
    stop_bot
    start_bot
}

install_bot() {
    require_venv
    mkdir -p "$LOG_DIR"
    echo "==> Installing launchd plist..."
    echo "    venv:    $VENV"
    echo "    cwd:     $REPO_ROOT"
    echo "    logs:    $LOG_DIR"
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$VENV/bin/python</string>
        <string>-m</string>
        <string>apps.workshop_bot.bot</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$VENV/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>PYTHONUNBUFFERED</key>
        <string>1</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>300</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/workshop.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/workshop.err</string>
</dict>
</plist>
PLIST
    echo "Installed $PLIST"
}

upgrade_bot() {
    require_venv
    stop_bot

    echo "==> Pulling latest from origin..."
    (cd "$REPO_ROOT" && git pull --ff-only origin main)

    echo "==> Synchronizing locked uv environment..."
    (cd "$REPO_ROOT" && uv sync --locked --no-dev)
    uv pip check --python "$VENV/bin/python"
    "$VENV/bin/python" -c 'import apps.workshop_bot.bot, aiohttp, anthropic, discord'

    start_bot
}

backup_db() {
    require_venv
    echo "==> Backing up workshop.db..."
    "$VENV/bin/python" "$SCRIPT_DIR/backup_db.py"
}

tail_logs() {
    mkdir -p "$LOG_DIR"
    touch "$LOG_DIR/workshop.log" "$LOG_DIR/workshop.err"
    echo "==> Tailing $LOG_DIR/workshop.{log,err} (Ctrl-C to stop)..."
    tail -F "$LOG_DIR/workshop.log" "$LOG_DIR/workshop.err"
}

case "${1:-}" in
    stop)     stop_bot ;;
    start)    start_bot ;;
    restart)  restart_bot ;;
    upgrade)  upgrade_bot ;;
    install)  install_bot ;;
    status)   status ;;
    backup)   backup_db ;;
    tail)     tail_logs ;;
    *)
        echo "Usage: $0 {start|stop|restart|upgrade|install|status|backup|tail}"
        exit 1
        ;;
esac
