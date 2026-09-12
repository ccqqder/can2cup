# Releasing, and falling back to an earlier version

The rule this document exists to keep true: **you can always ship the last
released version, no matter how half-finished `main` is.**

## Why this can go wrong

`main` moves ahead of what has been released. Right now, for example, `main`
carries the Tier‑1 sealed‑bid mechanism in `src/protocol/mechanism.ts` and a
suite of Tier‑2 prototypes under `demo/` — none of it released, the version
still `0.13.0`, the 0.14 bump deliberately held. HEAD is therefore **not** a
known‑good release; the last released source is the tag `v0.13.0`, not the tip
of `main`.

So the source of truth for "what is live" is the **tag**, never HEAD.

> Since 2026-09-12 this repository starts from a single commit of the 0.17.0 tree. Tags up to `v0.17.0` are in the
> maintainer's private archive of the earlier history (the versions themselves are on npm); `v0.17.1` is the first
> tag here. Rolling back to a version older than that means checking it out from the archive, or re-staging its bytes
> from npm with `release:relay` — the procedure below is the same.

## The release points are tagged

Every released version has an annotated tag at the exact source that produced
its tarball:

    v0.13.0   escape-hatch report + unproven≠CLEAN   (on npm)
    v0.12.2   refused LINE push is now visible         (relay only)
    v0.12.1   Discord via HTTP-only interactions       (relay only)
    v0.12.0   LINE bot moved into the relay Worker      (relay only)
    v0.11.3 … earlier

`git tag --sort=-creatordate` lists them newest first. The tarball itself is
gitignored (`*.tgz`, `dist/`) and rebuilt from source at release time, so the
tag — the source — is all that is needed to reproduce a release.

## Roll back: ship an earlier version from its tag

The release key is offline and never leaves the maintainer's machine, so the
final signing + deploy step always runs there. Two cases:

### The version is on npm (e.g. v0.13.0)

The relay is a mirror of npm. Re-stage npm's exact bytes, re-sign, redeploy:

    git switch --detach v0.13.0
    npm ci
    npm run release:relay        # routes-check → stage --from-npm → sign → wrangler deploy

Nothing is rebuilt locally; the relay is pointed back at the bytes npm already
serves. `main` is untouched.

### The version is NOT on npm (e.g. v0.12.x)

npm never received these, so build the tarball locally from the tag and serve
that:

    git switch --detach v0.12.1
    npm ci
    npm run pack                 # produces can2cup-0.12.1.tgz from this source
    npm run release:relay:local  # stage the LOCAL tarball → sign → wrangler deploy

`release:relay:local` differs from `release:relay` only in staging the locally
packed tarball instead of downloading from npm.

When done, return to work: `git switch main`.

## Forward policy — keep this document's promise true

1. **Tag every release** at the commit that ships it, `vMAJOR.MINOR.PATCH`.
   The tag drives the npm publish workflow and marks the fallback point. A
   release that is not tagged is a release you cannot cleanly roll back to.
2. **`main` may carry unreleased shipped-surface work** (it does now). That is
   fine *because* the last release is tagged — the tag, not HEAD, is what you
   check out to ship. Do not assume HEAD is releasable.
3. Before cutting a new release from `main`, confirm the shipped surface
   (`src/protocol`, `src/relay`, `README`, `SKILL.md`, `tsconfig.relay.json`,
   `wrangler.toml`, `docs/SELF-HOST.md`) builds and passes smoke — those are the
   files in `package.json`'s `files` list, i.e. what the tarball contains.
