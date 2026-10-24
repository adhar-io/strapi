#!/usr/bin/env bash
# Entrypoint of ghcr.io/adhar-io/strapi. See ./Dockerfile for the layout.
set -euo pipefail

DATA=/srv/app

# ── 1. The persistent paths ──
# The image links src/api, src/components, src/extensions and public/uploads
# into /srv/app. Create the targets on a fresh volume; an existing one (the
# previous self-scaffolding package used the same paths) is used as it is.
for d in src/api src/components src/extensions public/uploads; do
  mkdir -p "$DATA/$d"
done

# ── 2. Retire the self-scaffolded project from the previous package layout ──
# Until 5.57.0-1 the platform kept a whole project on this volume. Done once,
# marked by /srv/.adhar-image-layout:
#   - node_modules, build output and the version sentinel are derived (~700
#     MiB, the image carries them) and are deleted;
#   - everything else the scaffold wrote (package.json, config/, .env with the
#     scaffold's secrets, src/index.js, ...) is MOVED to /srv/legacy-scaffold,
#     not deleted, in case an operator edited it. Left in place it would sit in
#     Node's resolution path for the files below.
# Content is untouched: it is in Postgres and in the paths from step 1.
if [ ! -e /srv/.adhar-image-layout ]; then
  derived=()
  for p in "$DATA/node_modules" "$DATA/dist" "$DATA/build" "$DATA/.strapi" "$DATA/.cache" /srv/.admin-built; do
    if [ -e "$p" ] && [ ! -L "$p" ]; then derived+=("$p"); fi
  done
  if [ "${#derived[@]}" -gt 0 ]; then
    echo "==> previous layout: deleting derived files ${derived[*]}"
    rm -rf "${derived[@]}" || echo "!! could not delete all of it; it is unused and safe to delete by hand"
  fi
  moved=()
  shopt -s dotglob nullglob
  for p in "$DATA"/* "$DATA"/src/* "$DATA"/public/*; do
    case "${p#"$DATA"/}" in
      src | public | node_modules | src/api | src/components | src/extensions | public/uploads) continue ;;
    esac
    rel="${p#"$DATA"/}"
    mkdir -p "/srv/legacy-scaffold/$(dirname "$rel")"
    mv "$p" "/srv/legacy-scaffold/$rel" && moved+=("$rel")
  done
  shopt -u dotglob nullglob
  if [ "${#moved[@]}" -gt 0 ]; then
    echo "==> previous layout: moved ${moved[*]} to /srv/legacy-scaffold (unused; delete when satisfied)"
  fi
  touch /srv/.adhar-image-layout
fi

# Files under the persistent paths (the Content-Type Builder generates
# controllers, routes and services that `require('@strapi/strapi')`) are
# resolved by Node from their REAL path under /srv/app, so /srv/app must see
# the image's node_modules.
ln -sfn /opt/app/node_modules "$DATA/node_modules"

if grep -q ADHAR_BUNDLED_FEATURES node_modules/@strapi/core/dist/ee/index.js 2>/dev/null; then
  echo "==> Strapi $(node -p "require('@strapi/strapi/package.json').version") (Adhar @strapi/core, admin SSO available)"
fi

# ── 3. Serve ──
# develop (default): the Content-Type Builder only accepts schema changes when
#   autoReload is on, which only `strapi develop` sets — under `strapi start`
#   it is read-only whatever NODE_ENV says. The admin panel is the prebuilt one
#   (no Vite, no rebuild); the watcher restarts the server after a schema save.
# start: a fixed schema, for a CMS whose content types live in its own repo.
case "${STRAPI_ADHAR_MODE:-develop}" in
  develop)
    exec node_modules/.bin/strapi develop \
      --no-watch-admin --no-build-admin --no-install-deps "$@" ;;
  start)
    exec node_modules/.bin/strapi start "$@" ;;
  *)
    echo "STRAPI_ADHAR_MODE must be develop or start, got '${STRAPI_ADHAR_MODE}'" >&2
    exit 64 ;;
esac
