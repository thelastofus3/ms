#!/usr/bin/env bash
# Runs MasterProject on the LHC server without Docker: web (nginx), room-api (Java), PostgreSQL, MinIO,
# avatar-photos (FastAPI). Everything lives on the data disk; services listen on 127.0.0.1 only.
#
#   bash deploy/lhc/lhc.sh setup     one-time: Miniforge env, MinIO, secrets, PostgreSQL cluster
#   bash deploy/lhc/lhc.sh build     npm build of apps/web + Maven package of services/space-api
#   bash deploy/lhc/lhc.sh start | stop | restart | status
#   bash deploy/lhc/lhc.sh logs <postgres|minio|room-api|avatar-photos|nginx>
#   bash deploy/lhc/lhc.sh update    git pull + build + restart
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SELF="$REPO/deploy/lhc/lhc.sh"
DATA="${LHC_DATA:-/srv/lhc-student-data/student2}"
RUN="$DATA/ms-run"
CONDA="$DATA/miniforge3"
ENV_PREFIX="$CONDA/envs/ms"
ENVFILE="$RUN/ms.env"
JAR="$REPO/services/space-api/target/space-api-0.1.0.jar"
DIST="$REPO/apps/web/dist"
MINIO_VERSION="2025.10.15.17.29.55"   # same MinIO release compose builds (RELEASE.2025-10-15T17-29-55Z)

log() { printf '\033[1m[lhc]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[lhc] %s\033[0m\n' "$*" >&2; exit 1; }

[ -d "$DATA" ] && [ -w "$DATA" ] || die "Data disk $DATA is missing or not writable (set LHC_DATA)"
# /tmp on the server is a 64 MB tmpfs: every tool must use the data disk for temporary files.
export TMPDIR="$DATA/tmp"
export PIP_CACHE_DIR="$TMPDIR/pip" npm_config_cache="$TMPDIR/npm" CONDA_PKGS_DIRS="$CONDA/pkgs"
export MAVEN_OPTS="${MAVEN_OPTS:-} -Djava.io.tmpdir=$TMPDIR"
export PATH="$ENV_PREFIX/bin:$PATH"
unset JAVA_HOME
mkdir -p "$TMPDIR" "$RUN"/{logs,pids,minio,photos,nginx/temp}

pidfile() { if [ "$1" = nginx ]; then echo "$RUN/nginx/nginx.pid"; else echo "$RUN/pids/$1.pid"; fi; }
running() {
  if [ "$1" = postgres ]; then pg_ctl -D "$RUN/pg" status >/dev/null 2>&1; return; fi
  local pid; pid="$(cat "$(pidfile "$1")" 2>/dev/null)" || return 1
  kill -0 "$pid" 2>/dev/null
}
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
need_port() { if port_busy "$2"; then die "Port $2 for $1 is already taken - change it in $ENVFILE"; fi; }

spawn() {  # spawn <name> <command...>: detached from the SSH session so logout does not stop it
  local name="$1"; shift
  setsid nohup "$@" >>"$RUN/logs/$name.log" 2>&1 </dev/null &
  echo $! >"$(pidfile "$name")"
  log "Started $name (pid $!)"
}

wait_http() {  # wait_http <name> <url> [expected substring]
  local i out
  for i in $(seq 1 90); do
    if out="$(curl -fsS --max-time 3 "$2" 2>/dev/null)" && [[ -z "${3:-}" || "$out" == *"$3"* ]]; then return 0; fi
    running "$1" || die "$1 stopped - see: bash $SELF logs $1"
    sleep 2
  done
  die "$1 did not become healthy within 3 minutes - see: bash $SELF logs $1"
}

secret() { python -c "import base64, secrets; $1"; }

write_env() {
  if [ -f "$ENVFILE" ]; then log "Keeping existing $ENVFILE"; return; fi
  local admin; admin="$(secret 'print(secrets.token_urlsafe(15))')"
  (
    umask 077
    cat >"$ENVFILE" <<EOF
# MasterProject on LHC. Secrets live only in this file - never commit it.
WEB_PORT=28080
API_PORT=28003
PHOTO_PORT=28002
S3_PORT=29000
S3_CONSOLE_PORT=29001
PG_PORT=25433
API_HEAP=512m
# Public self-registration (new SPLAT_UPLOADER accounts). Keep "no" on a public server; the admin creates accounts.
ALLOW_REGISTRATION=no
# Address users open in the browser. Once student2.mmclab.eu points at WEB_PORT, set:
# PUBLIC_URL=https://student2.mmclab.eu
PUBLIC_URL=http://localhost:28080
ROOM_ADMIN_USERNAME=admin
ROOM_ADMIN_PASSWORD=$admin
ROOM_JWT_SECRET=$(secret 'print(base64.b64encode(secrets.token_bytes(48)).decode())')
ROOM_DATABASE_PASSWORD=$(secret 'print(secrets.token_hex(16))')
ROOM_S3_ACCESS_KEY=rooms-$(secret 'print(secrets.token_hex(4))')
ROOM_S3_SECRET_KEY=$(secret 'print(secrets.token_hex(24))')
ROOM_ACCOUNT_STORAGE_GIB=20
ROOM_ACCOUNT_PENDING_UPLOADS=3
ROOM_ACCOUNT_ACTIVE_JOBS=2
ROOM_UPLOAD_TTL_HOURS=24
EOF
  )
  log "Admin account: admin / $admin   (stored in $ENVFILE)"
}

load_env() {
  [ -f "$ENVFILE" ] || die "Missing $ENVFILE - run: bash $SELF setup"
  set -a; . "$ENVFILE"; set +a
  ALLOW_REGISTRATION="${ALLOW_REGISTRATION:-no}"   # closed unless explicitly enabled
  export ROOM_BROWSER_ORIGINS="$PUBLIC_URL,http://localhost:$WEB_PORT,http://127.0.0.1:$WEB_PORT"
  export ROOM_S3_BUCKET=rooms
}

cmd_setup() {
  df -h "$DATA" | tail -1
  if [ ! -x "$CONDA/bin/conda" ]; then
    log "Installing Miniforge into $CONDA"
    curl -fsSL -o "$TMPDIR/miniforge.sh" \
      https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Linux-x86_64.sh
    bash "$TMPDIR/miniforge.sh" -b -p "$CONDA"
    rm -f "$TMPDIR/miniforge.sh"
  fi
  if [ ! -x "$ENV_PREFIX/bin/python" ]; then
    log "Creating env $ENV_PREFIX (Python 3.12, JDK 21, Maven, Node 22, PostgreSQL 17, nginx, MinIO)"
    "$CONDA/bin/conda" create -y -p "$ENV_PREFIX" --override-channels -c conda-forge \
      python=3.12 openjdk=21 maven nodejs=22 postgresql=17 nginx "minio-server=$MINIO_VERSION"
  elif [ ! -x "$ENV_PREFIX/bin/minio" ]; then
    "$CONDA/bin/conda" install -y -p "$ENV_PREFIX" --override-channels -c conda-forge "minio-server=$MINIO_VERSION"
  fi
  python -m pip install --quiet --upgrade pip
  python -m pip install --quiet -e "$REPO/services/avatar" boto3==1.37.38
  write_env
  load_env
  if [ ! -f "$RUN/pg/PG_VERSION" ]; then
    log "Initialising PostgreSQL cluster in $RUN/pg"
    (umask 077; printf '%s\n' "$ROOM_DATABASE_PASSWORD" >"$TMPDIR/pgpw")
    initdb -D "$RUN/pg" -U rooms --pwfile="$TMPDIR/pgpw" -A scram-sha-256 -E UTF8 --no-locale >/dev/null
    rm -f "$TMPDIR/pgpw"
  fi
  log "Setup done. Next: bash $SELF build"
}

cmd_build() {
  log "Building web (npm ci + vite build)"
  (cd "$REPO/apps/web" && npm ci --no-audit --no-fund && npm run build)
  log "Building room-api (Maven, tests skipped)"
  (cd "$REPO/services/space-api" && mvn -B -q -DskipTests -Dmaven.repo.local="$DATA/m2" package)
  python -m pip install --quiet -e "$REPO/services/avatar"
  log "Build done: $(du -sh "$DIST" | cut -f1) web, $(du -h "$JAR" | cut -f1) jar. Next: bash $SELF start"
}

start_postgres() {
  if running postgres; then log "postgres already running"; else
    need_port postgres "$PG_PORT"
    setsid pg_ctl -D "$RUN/pg" -l "$RUN/logs/postgres.log" -w -t 60 \
      -o "-c listen_addresses=127.0.0.1 -p $PG_PORT -k $RUN/pg" start >/dev/null
    log "Started postgres on 127.0.0.1:$PG_PORT"
  fi
  export PGPASSWORD="$ROOM_DATABASE_PASSWORD"
  psql -h 127.0.0.1 -p "$PG_PORT" -U rooms -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='rooms'" \
    | grep -q 1 || createdb -h 127.0.0.1 -p "$PG_PORT" -U rooms rooms
  unset PGPASSWORD
}

start_minio() {
  if running minio; then log "minio already running"; return; fi
  need_port minio "$S3_PORT"
  spawn minio env MINIO_ROOT_USER="$ROOM_S3_ACCESS_KEY" MINIO_ROOT_PASSWORD="$ROOM_S3_SECRET_KEY" \
    MINIO_API_CORS_ALLOW_ORIGIN="$ROOM_BROWSER_ORIGINS" MINIO_BROWSER=off \
    minio server "$RUN/minio" --address "127.0.0.1:$S3_PORT" --console-address "127.0.0.1:$S3_CONSOLE_PORT"
  wait_http minio "http://127.0.0.1:$S3_PORT/minio/health/live"
  env ROOM_S3_PROVIDER=minio ROOM_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" \
    python "$REPO/services/space-storage/init.py" >>"$RUN/logs/minio.log" 2>&1
}

start_api() {
  if running room-api; then log "room-api already running"; return; fi
  [ -f "$JAR" ] || die "No $JAR - run: bash $SELF build"
  need_port room-api "$API_PORT"
  # Presigned S3 URLs point at PUBLIC_URL; nginx forwards /rooms/ (path-style bucket) to MinIO.
  spawn room-api env SERVER_ADDRESS=127.0.0.1 SERVER_PORT="$API_PORT" \
    ROOM_DATABASE_URL="jdbc:postgresql://127.0.0.1:$PG_PORT/rooms" ROOM_DATABASE_USER=rooms \
    ROOM_AUTH_TRUSTED_PROXIES=127.0.0.1 \
    ROOM_S3_ENDPOINT="http://127.0.0.1:$S3_PORT" ROOM_S3_PUBLIC_ENDPOINT="$PUBLIC_URL" \
    java -Xms128m -Xmx"$API_HEAP" -XX:MaxMetaspaceSize=256m -XX:+UseSerialGC -XX:+ExitOnOutOfMemoryError \
      -Djava.io.tmpdir="$TMPDIR" -jar "$JAR"
  wait_http room-api "http://127.0.0.1:$API_PORT/actuator/health" UP
}

start_photos() {
  if running avatar-photos; then log "avatar-photos already running"; return; fi
  need_port avatar-photos "$PHOTO_PORT"
  spawn avatar-photos env PHOTO_DATA_DIR="$RUN/photos" \
    ROOM_AUTH_API_URL="http://127.0.0.1:$API_PORT/v1/rooms/auth/me" \
    python -m uvicorn avatar_service.photo_api:create_photo_app --factory --host 127.0.0.1 --port "$PHOTO_PORT"
  wait_http avatar-photos "http://127.0.0.1:$PHOTO_PORT/health"
}

nginx_cmd() { nginx -p "$RUN/nginx" -c "$RUN/nginx/nginx.conf" -e "$RUN/logs/nginx.log" "$@"; }

start_nginx() {
  [ -f "$DIST/index.html" ] || die "No web build - run: bash $SELF build"
  sed -e "s|@RUN@|$RUN|g" -e "s|@DIST@|$DIST|g" -e "s|@WEB_PORT@|$WEB_PORT|g" \
      -e "s|@API_PORT@|$API_PORT|g" -e "s|@PHOTO_PORT@|$PHOTO_PORT|g" -e "s|@S3_PORT@|$S3_PORT|g" \
      "$REPO/deploy/lhc/nginx.conf.template" >"$RUN/nginx/nginx.conf"
  if [ "$ALLOW_REGISTRATION" = yes ]; then
    : >"$RUN/nginx/registration.conf"
  else
    cat >"$RUN/nginx/registration.conf" <<'EOF'
location = /v1/rooms/auth/register {
    default_type application/json;
    return 403 '{"message": "Registration is disabled. Ask the administrator for an account."}';
}
EOF
  fi
  nginx_cmd -t -q || die "nginx config test failed"
  if running nginx; then nginx_cmd -s reload; log "nginx reloaded"; return; fi
  need_port nginx "$WEB_PORT"
  nginx_cmd
  wait_http nginx "http://127.0.0.1:$WEB_PORT/healthz" ok
  log "Started nginx on 127.0.0.1:$WEB_PORT"
}

cmd_start() {
  start_postgres
  start_minio
  start_api
  start_photos
  start_nginx
  cmd_status
}

stop_one() {
  local name="$1" pid i
  running "$name" || { rm -f "$(pidfile "$name")"; return 0; }
  pid="$(cat "$(pidfile "$name")")"
  kill "$pid"
  for i in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
  rm -f "$(pidfile "$name")"
  log "Stopped $name"
}

cmd_stop() {
  stop_one nginx
  stop_one avatar-photos
  stop_one room-api
  stop_one minio
  if running postgres; then pg_ctl -D "$RUN/pg" -m fast -w stop >/dev/null; log "Stopped postgres"; fi
}

cmd_status() {
  local s
  for s in postgres minio room-api avatar-photos nginx; do
    if running "$s"; then printf '  %-14s \033[32mrunning\033[0m\n' "$s"; else printf '  %-14s \033[31mstopped\033[0m\n' "$s"; fi
  done
  printf '  %-14s %s\n' "web health" "$(curl -fsS --max-time 3 "http://127.0.0.1:$WEB_PORT/health/" 2>&1 || true)"
  printf '  %-14s %s\n' "registration" "$([ "$ALLOW_REGISTRATION" = yes ] && echo open || echo closed)"
  echo
  echo "  Test from your PC:  ssh -N -L $WEB_PORT:127.0.0.1:$WEB_PORT lhc-student2   then open http://localhost:$WEB_PORT"
  echo "  Public address:     $PUBLIC_URL"
}

case "${1:-}" in
  setup)   cmd_setup ;;
  build)   load_env; cmd_build ;;
  start)   load_env; cmd_start ;;
  stop)    load_env; cmd_stop ;;
  restart) load_env; cmd_stop; cmd_start ;;
  status)  load_env; cmd_status ;;
  update)  load_env; git -C "$REPO" pull --ff-only; cmd_build; cmd_stop; cmd_start ;;
  logs)    [ -n "${2:-}" ] || die "Usage: bash $SELF logs <postgres|minio|room-api|avatar-photos|nginx>"
           tail -n 100 -f "$RUN/logs/$2.log" ;;
  *)       sed -n '2,10p' "$SELF"; exit 1 ;;
esac
