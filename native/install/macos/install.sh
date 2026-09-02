#!/bin/sh
set -eu

binary="${1:?Pass the drake-speech-service binary path.}"
install_dir="$HOME/Library/Application Support/Drake Speech/bin"
agent_dir="$HOME/Library/LaunchAgents"
agent_file="$agent_dir/com.drakeshadwell.drake-speech.plist"

mkdir -p "$install_dir" "$agent_dir"
chmod 700 "$install_dir"
cp "$binary" "$install_dir/drake-speech-service"
chmod 700 "$install_dir/drake-speech-service"

sed "s|__BINARY__|$install_dir/drake-speech-service|g" "$(dirname "$0")/com.drakeshadwell.drake-speech.plist" > "$agent_file"
chmod 600 "$agent_file"
launchctl bootout "gui/$(id -u)/com.drakeshadwell.drake-speech" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$agent_file"
