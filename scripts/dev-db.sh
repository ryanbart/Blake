#!/usr/bin/env bash
# Local Postgres 16 for development. No Docker required — uses the cluster
# binaries directly so the DB lives inside the repo and is trivially disposable.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="${PGDATA:-$REPO_ROOT/.pgdata}"
PGPORT="${PGPORT:-5433}"
PGSOCKET="${PGSOCKET:-$PGDATA/sockets}"
DB_NAME="${DB_NAME:-blake}"
LOGFILE="$PGDATA/postgres.log"

find_bindir() {
  if command -v pg_ctl >/dev/null 2>&1; then
    dirname "$(command -v pg_ctl)"
    return
  fi
  # Debian/Ubuntu keep server binaries out of PATH; take the highest version.
  local candidate
  candidate="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
  if [[ -n "$candidate" && -x "$candidate/pg_ctl" ]]; then
    echo "$candidate"
    return
  fi
  echo "error: could not find pg_ctl. Install postgresql-16 or set PATH." >&2
  exit 1
}

BINDIR="$(find_bindir)"

# Postgres refuses to run as root. When invoked as root (common in containers),
# run the server as the unprivileged `postgres` system user instead.
RUN_AS=""
if [[ "$(id -u)" -eq 0 ]]; then
  if id postgres >/dev/null 2>&1; then
    RUN_AS="postgres"
  else
    echo "error: running as root and no 'postgres' user exists to drop to." >&2
    echo "hint: useradd --system postgres, or run this script as a normal user." >&2
    exit 1
  fi
fi

# Run a command as the server user, preserving the environment we care about.
as_pg() {
  if [[ -n "$RUN_AS" ]]; then
    su "$RUN_AS" -s /bin/bash -c "$(printf '%q ' "$@")"
  else
    "$@"
  fi
}

start() {
  mkdir -p "$PGDATA"
  if [[ -n "$RUN_AS" ]]; then
    # The server user needs to traverse the repo path and own its data dir.
    chown -R "$RUN_AS" "$PGDATA"
    chmod 711 "$REPO_ROOT" 2>/dev/null || true
  fi

  # initdb requires an empty target, so it must run before the socket dir exists.
  if [[ ! -d "$PGDATA/base" ]]; then
    echo "==> initdb $PGDATA"
    as_pg "$BINDIR/initdb" -D "$PGDATA" -U postgres --auth=trust >/dev/null
  fi

  mkdir -p "$PGSOCKET"
  [[ -n "$RUN_AS" ]] && chown "$RUN_AS" "$PGSOCKET"

  if as_pg "$BINDIR/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    echo "==> postgres already running on port $PGPORT"
  else
    echo "==> starting postgres on port $PGPORT"
    as_pg "$BINDIR/pg_ctl" -D "$PGDATA" -l "$LOGFILE" \
      -o "-p $PGPORT -k $PGSOCKET -c listen_addresses=127.0.0.1" \
      -w start
  fi

  if ! "$BINDIR/psql" -h 127.0.0.1 -p "$PGPORT" -U postgres -lqt \
      | cut -d'|' -f1 | grep -qw "$DB_NAME"; then
    echo "==> creating database $DB_NAME"
    "$BINDIR/createdb" -h 127.0.0.1 -p "$PGPORT" -U postgres "$DB_NAME"
  fi

  cat <<EOF

Postgres is up. Add this to .env if it isn't there already:

  DATABASE_URL="postgresql://postgres@127.0.0.1:$PGPORT/$DB_NAME?schema=public"

EOF
}

stop() {
  if as_pg "$BINDIR/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1; then
    as_pg "$BINDIR/pg_ctl" -D "$PGDATA" -w stop
  else
    echo "==> postgres is not running"
  fi
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop || true; start ;;
  status) as_pg "$BINDIR/pg_ctl" -D "$PGDATA" status ;;
  logs) tail -f "$LOGFILE" ;;
  nuke)
    stop || true
    rm -rf "$PGDATA"
    echo "==> removed $PGDATA"
    ;;
  *)
    echo "usage: $0 {start|stop|restart|status|logs|nuke}" >&2
    exit 1
    ;;
esac
