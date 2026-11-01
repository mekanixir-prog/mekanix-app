#!/bin/bash
# Helpers for using PostgreSQL connection URLs without putting credentials in
# pg_dump/psql command-line arguments. The temporary libpq service file is 0600
# and removed immediately after each command.

create_pg_service_file() {
  local url="$1"
  local service_file="$2"
  PG_URL_TO_PARSE="$url" python3 - "$service_file" <<'PY'
import os
import sys
from urllib.parse import parse_qsl, unquote, urlsplit

target = sys.argv[1]
raw = os.environ.get("PG_URL_TO_PARSE", "")
parts = urlsplit(raw)
if parts.scheme not in ("postgres", "postgresql") or not parts.hostname or not parts.path.strip("/"):
    raise SystemExit("Invalid PostgreSQL connection URL")

values = {
    "host": parts.hostname,
    "port": str(parts.port or 5432),
    "dbname": unquote(parts.path.lstrip("/")),
}
if parts.username:
    values["user"] = unquote(parts.username)
if parts.password:
    values["password"] = unquote(parts.password)

allowed_query = {
    "sslmode", "sslcert", "sslkey", "sslrootcert",
    "connect_timeout", "application_name", "options",
}
for key, value in parse_qsl(parts.query, keep_blank_values=True):
    if key in allowed_query and value:
        values[key] = value

def quote(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"

with open(target, "w", encoding="utf-8") as handle:
    handle.write("[mekanix]\n")
    for key, value in values.items():
        handle.write(f"{key}={quote(value)}\n")
PY
  chmod 600 "$service_file"
}

pg_exec() {
  local url="$1"
  shift
  local service_file
  service_file="$(mktemp)"
  if ! create_pg_service_file "$url" "$service_file"; then
    rm -f "$service_file"
    return 1
  fi
  local status=0
  PGSERVICEFILE="$service_file" PGSERVICE=mekanix "$@" || status=$?
  rm -f "$service_file"
  return "$status"
}
