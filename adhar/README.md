# Adhar fork of Strapi

This fork exists for one change and one artifact:

- **The change**: `packages/core/core/src/ee/index.ts` adds `sso` to
  `ADHAR_BUNDLED_FEATURES`, so the admin panel accepts Keycloak logins without
  a Strapi licence. Every other Enterprise feature stays locked. The invariant
  test is `packages/core/core/src/ee/__tests__/adhar-bundled-features.test.ts`.
- **The artifact**: `ghcr.io/adhar-io/strapi:<strapi version>-<n>`, a
  ready-to-run server built from `adhar/docker/`. The Adhar platform's
  `strapi` package (`adhar` repo,
  `platform/stack/packages/application/strapi`) runs it.

Everything Adhar-specific lives in `adhar/` and
`.github/workflows/adhar-release.yml`, so upstream merges don't conflict.

## Cutting a release

Strapi's packages move in lockstep, and the image scaffolds its project at the
same version as the patched core. That means every release branches from an
**upstream tag**:

```bash
git fetch upstream --tags
git switch -c adhar/v5.58.0 v5.58.0
git cherry-pick <the adhar commits from the previous adhar/v* branch>
git push origin adhar/v5.58.0

# Publish: either trigger works. The branch trigger is the fallback for tag pushes that fail to start a run.
git tag adhar-v5.58.0-1 && git push origin adhar-v5.58.0-1
git push origin HEAD:release/5.58.0-1
```

`-<n>` counts Adhar rebuilds of the same upstream version. Bump it whenever
`adhar/` or the patch changes. The workflow rejects a version that doesn't
match the tree's `@strapi/core`.

The workflow then:

1. builds and packs `@strapi/core`, runs the invariant test, and checks that
   `dist/ee/index.js` carries the marker;
2. builds the image natively on amd64 and arm64, and smoke-tests each one;
3. pushes `:<version>` and `:latest`, then Cosign-signs the digest (keyless);
4. cuts the GitHub release `adhar-v<version>` with the core tarball.

Finally, bump the platform pin: `image:` in the `adhar` repo's
`strapi/manifests/install.yaml`, plus `appVersion` in `adhar-package.yaml`.

## The image

| Path in the image                                                 | What it is                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/opt/app`                                                        | Scaffolded with `create-strapi@<version>` (JavaScript, Postgres). Uses the fork's core through an npm override, with the admin panel prebuilt. Every lockstep `@strapi/*` package is pinned to `<version>` (`build/pin-lockstep.js`), because plugins peer-depend on `@strapi/admin ^5.0.0` and npm would otherwise hoist the newest 5.x beside them. The build fails if anything still drifts. |
| `/opt/app/config/server.js`                                       | `url` from `PUBLIC_URL`, `proxy` on (behind the Gateway).                                                                                                                                                                                                                                                                                                                                       |
| `/opt/app/config/admin.js`                                        | Keycloak admin login, active once `KEYCLOAK_ISSUER_URL`, `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` and `PUBLIC_URL` are set. `KEYCLOAK_INTERNAL_ISSUER_URL` handles the server-side calls.                                                                                                                                                                                                 |
| `/opt/app/src/index.js`                                           | On bootstrap, turns on SSO auto-register with the role named by `STRAPI_SSO_DEFAULT_ROLE`.                                                                                                                                                                                                                                                                                                      |
| `/srv/app/{src/api,src/components,src/extensions,public/uploads}` | **Persistent.** Mount a volume at `/srv`. The app paths are symlinks into it.                                                                                                                                                                                                                                                                                                                   |

`STRAPI_ADHAR_MODE=develop` (the default) runs `strapi develop` against the
prebuilt admin, without Vite or a rebuild. The Content-Type Builder only
accepts schema changes when `autoReload` is on, and only `develop` sets it.
`STRAPI_ADHAR_MODE=start` runs `strapi start` for a fixed schema.

`/srv/app/node_modules` is a link to the image's `node_modules`. Node resolves
the files the Content-Type Builder generates (which `require('@strapi/strapi')`)
from their real path under `/srv/app`, so that path has to see the image's
modules.

On its first start on a volume from the platform's previous self-scaffolding
layout, the entrypoint migrates it once and records that in
`/srv/.adhar-image-layout`. It deletes the derived files (`node_modules`, build
output, `/srv/.admin-built`; about 700 MiB) and moves everything else the old
scaffold wrote (`package.json`, `config/`, `.env`, `src/index.js`, ...) to
`/srv/legacy-scaffold`, in case an operator edited any of it.

Build locally:

```bash
yarn install && yarn nx build @strapi/core
(cd packages/core/core && npm pack --pack-destination ../../../adhar/docker)
mv adhar/docker/strapi-core-*.tgz adhar/docker/strapi-core.tgz
docker build --build-arg STRAPI_VERSION=5.57.0 -t strapi:dev adhar/docker
```

## Licence

Code under an `ee/` directory is covered by `packages/core/admin/ee/LICENSE`,
not the repository's MIT licence. Enabling SSO from it was a deliberate
decision by the Adhar maintainers.
