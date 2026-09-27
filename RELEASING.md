# Releasing

Maintainer notes for cutting a release. The package identity lives in
`package.json`; the published artefact is the compiled `lib/` plus
`cordis.patch.yml` and the READMEs.

## Prerequisites

- Write access to the npm package `@5havv/dsh-weixin` (the account that owns the
  `@5havv` scope).
- Push access to `main` on GitHub.
- A local checkout with dependencies installed (`npm install`).

## Before publishing

Run every gate and **check each exit code**. Piping a test command into `grep`
hides its status and has already let a failing revision reach `main` once:

```sh
ok=1
npx tsc --noEmit        >/tmp/tc.out 2>&1 || { echo 'typecheck failed'; cat /tmp/tc.out; ok=0; }
npx vitest run          >/tmp/vt.out 2>&1 || { echo 'tests failed'; grep -E 'FAIL|✕' /tmp/vt.out; ok=0; }
npm run verify --silent >/tmp/vf.out 2>&1 || { echo 'integration failed'; tail -5 /tmp/vf.out; ok=0; }
npm run build --silent  >/tmp/bd.out 2>&1 || { echo 'build failed'; ok=0; }
[ $ok -eq 1 ] || exit 1
```

Then confirm the artefact itself:

```sh
npm pack --dry-run      # lib/, cordis.patch.yml, LICENSE and both READMEs must be listed
```

## Cutting the release

1. **Bump `version`** in `package.json`. Keep the version quoted in both READMEs
   in step, and update any example that names a tarball
   (`5havv-dsh-weixin-<version>.tgz`).
2. **Commit and push** to `main`.
3. **Publish**: `npm publish`. `prepublishOnly` re-runs typecheck, tests,
   integration checks, and the build, so a broken revision cannot be published.
   If the account requires 2FA, npm prompts for a one-time code — a code is
   valid for about 30 seconds, so run this in a terminal you control.
4. **Tag**: `git tag -a v<version> -m '<notes>' && git push origin v<version>`,
   then create the GitHub release from that tag.

## After publishing

Verify that a consumer can actually install it — publishing is not the same as
being installable:

```sh
npm view @5havv/dsh-weixin version

dsh plugin --profile releasetest add @5havv/dsh-weixin
dsh --profile releasetest --dump-config | grep -A 6 '== @5havv/dsh-weixin'
rm -rf "$DSH_HOME/profiles/releasetest"
```

The composed config must show both the `weixin` and `weixin-bridge` rows. If it
shows none, the package installed as an inert dependency — check that
`package.json` still declares:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

Without that manifest `dsh plugin add` reports success while activating no
plugin at all, which is the hardest failure mode to notice.

## Things that bite

- **A newly published package can be invisible for hours.** Observed once: the
  tarball and `/@scope/name/latest` resolved immediately while
  `/@scope/name` (the packument every package manager reads) returned 404 for
  about 8.5 hours. That is registry-side propagation, not a failed publish —
  check that the tarball downloads, that the search index lists the package, and
  that `npm access get status <pkg>` says `public`, then wait rather than
  republishing.
- **A scoped package needs `publishConfig.access: "public"`**, or it publishes as
  restricted and a free account cannot push it.
- **`npm whoami` can report `ENEEDAUTH` while you are logged in.** Credentials are
  stored per registry; if the default registry is a mirror, there is simply no
  credential for it. Check with `npm whoami --registry=https://registry.npmjs.org/`.
- **Do not put probabilistic assertions in the test suite.** One test asserted
  that decrypting under a random key throws, but PKCS#7 padding is valid about
  once in 256; measured over 100k trials it failed to throw 0.37% of the time
  and eventually failed CI. Only assert properties that hold by construction.
- **Test-only changes do not need a release.** Tests are not part of the
  published artefact.
