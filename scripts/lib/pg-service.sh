#!/bin/bash
# PostgreSQL connection helper. Credentials are written only to a short-lived
# mode-0600 .pgpass file; connection parameters are exported without secrets.

create_pg_connection_files() {
  local url="$1"
  local pass_file="$2"
  local env_file="$3"
  PG_URL_TO_PARSE="$url" python3 - "$pass_file" "$env_file" <<'PY'
import os
import shlex
import sys
from urllib.parse import parse_qsl, unquote, urlsplit

pass_path, env_path = sys.argv[1], sys.argv[2]
parts = urlsplit(os.environ.get("PG_URL_TO_PARSE", ""))
if parts.scheme not in ("postgres", "postgresql") or not parts.hostname or not parts.path.strip("/"):
    raise SystemExit("Invalid PostgreSQL connection URL")

host = parts.hostname
port = str(parts.port or 5432)
database = unquote(parts.path.lstrip("/"))
user = unquote(parts.username or "")
password = unquote(parts.password or "")

def pgpass_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace(":", "\\:")

with open(pass_path, "w", encoding="utf-8") as handle:
    if password:
        handle.write(":".join(pgpass_escape(value) for value in (host, port, database, user, password)) + "\n")

env = {
    "PGHOST": host,
    "PGPORT": port,
    "PGDATABASE": database,
    "PGUSER": user,
}
allowed = {
    "sslmode": "PGSSLMODE",
    "sslcert": "PGSSLCERT",
    "sslkey": "PGSSLKEY",
    "sslrootcert": "PGSSLROOTCERT",
    "connect_timeout": "PGCONNECT_TIMEOUT",
    "application_name": "PGAPPNAME",
    "options": "PGOPTIONS",
}
for key, value in parse_qsl(parts.query, keep_blank_values=True):
    if key in allowed and value:
        env[allowed[key]] = value

with open(env_path, "w", encoding="utf-8") as handle:
    for key, value in env.items():
        if "\n" in value or "\r" in value:
            raise SystemExit("Invalid newline in PostgreSQL connection parameter")
        handle.write(f"export {key}={shlex.quote(value)}\n")
PY
  chmod 600 "$pass_file" "$env_file"
}

pg_exec() {
  local url="$1"
  shift
  local pass_file env_file status=0
  pass_file="$(mktemp)"
  env_file="$(mktemp)"
  if ! create_pg_connection_files "$url" "$pass_file" "$env_file"; then
    rm -f "$pass_file" "$env_file"
    return 1
  fi
  (
    # shellcheck disable=SC1090
    source "$env_file"
    export PGPASSFILE="$pass_file"
    "$@"
  ) || status=$?
  rm -f "$pass_file" "$env_file"
  return "$status"
}
