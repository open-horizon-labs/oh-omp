#!/usr/bin/env bash
set -euo pipefail

FILE_PATH="${SESSIONS_FILE:-sessions.txt}"

usage() {
  cat <<'EOF'
Usage:
  sessions.sh add <session-key> <session-id> [--file path]
  sessions.sh find <query> [--file path]

If you pass --file, it may appear before or after the command arguments.
Examples:
  sessions.sh add WR:ai-roleplay 14f98893a776c336
  sessions.sh add WR:ai-roleplay 14f98893a776c336 --file ./sessions.txt
  sessions.sh find ai-roleplay
  sessions.sh find --file ./sessions.txt 14f988
EOF
}

next_session_index() {
  if [[ ! -f "$FILE_PATH" ]]; then
    echo 1
    return
  fi

  awk -F# '
BEGIN { max_index = 0 }
$1 ~ /^[0-9]+$/ {
  if ($1 + 0 > max_index) {
    max_index = $1 + 0
  }
}
END {
  if (max_index > 0) {
    print max_index + 1
  } else {
    print NR + 1
  }
}
' "$FILE_PATH"
}

session_exists() {
  local session_id="$1"
  awk -F, -v sid="$session_id" '
BEGIN { found = 0 }
{
  if ($2 == sid) {
    found = 1
    exit
  }
}
END {
  exit !found
}
' "$FILE_PATH"
}

add_session() {
  local key="$1"
  local sid="$2"

  if [[ -z "$key" || -z "$sid" ]]; then
    echo "add requires <session-key> and <session-id>" >&2
    return 1
  fi

  if [[ -e "$FILE_PATH" && ! -f "$FILE_PATH" ]]; then
    echo "Target file is not a regular file: $FILE_PATH" >&2
    return 1
  fi

  if [[ ! -e "$FILE_PATH" ]]; then
    : > "$FILE_PATH"
  fi

  if session_exists "$sid"; then
    echo "Session ID already exists in $FILE_PATH: $sid" >&2
    return 1
  fi

  local index
  index="$(next_session_index)"
  printf '%s#%s,%s\n' "$index" "$key" "$sid" >> "$FILE_PATH"
  echo "Added: ${index}#${key},${sid}"
}

find_session() {
  local query="$1"

  if [[ ! -f "$FILE_PATH" ]]; then
    echo "No sessions file found: $FILE_PATH" >&2
    return 1
  fi

  awk -v q="$query" 'BEGIN { IGNORECASE = 1 } index(tolower($0), tolower(q)) { print }' "$FILE_PATH"
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 1
  fi

  local cmd="$1"
  shift

  case "$cmd" in
    add)
      local key=""
      local sid=""

      while [[ $# -gt 0 ]]; do
        case "$1" in
          --file)
            FILE_PATH="$2"
            shift 2
            ;;
          --)
            shift
            break
            ;;
          *)
            if [[ -z "$key" ]]; then
              key="$1"
            elif [[ -z "$sid" ]]; then
              sid="$1"
            else
              echo "add only accepts <session-key> and <session-id>" >&2
              usage
              exit 1
            fi
            shift
            ;;
        esac
      done

      if [[ -z "$key" || -z "$sid" ]]; then
        echo "add needs <session-key> and <session-id>" >&2
        usage
        exit 1
      fi

      add_session "$key" "$sid"
      ;;

    find)
      local query=""

      while [[ $# -gt 0 ]]; do
        case "$1" in
          --file)
            FILE_PATH="$2"
            shift 2
            ;;
          --)
            shift
            break
            ;;
          *)
            if [[ -z "$query" ]]; then
              query="$1"
            else
              echo "find accepts a single query string" >&2
              usage
              exit 1
            fi
            shift
            ;;
        esac
      done

      if [[ -z "$query" ]]; then
        echo "find needs <query>" >&2
        usage
        exit 1
      fi

      find_session "$query"
      ;;

    *)
      echo "Unknown command: $cmd" >&2
      usage
      exit 1
      ;;
  esac
}

main "$@"
