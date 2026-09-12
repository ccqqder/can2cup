# Releasing

npm is first-hand, the relay is the mirror, the maintainer's offline key signs what both serve — and nothing goes live
on npm without a human's 2FA (staged publishing), so a compromised CI cannot ship a first install. Rolling back to an
earlier tag is in [RELEASE-ROLLBACK.md](RELEASE-ROLLBACK.md).

**Where the tags are.** This repository starts on 2026-09-12 from a single commit of the 0.17.0 tree; the history before
it, with the tags `v0.10.x` … `v0.17.0` and their GitHub Releases, is in the maintainer's private archive. Versions up to
0.17.0 are on npm as published. The first tag in this repository is `v0.17.1`; from there on every release is tagged
here as described below.

## The procedure

```bash
# 1. bump package.json (+ server.json) and add the entry to relay-assets/changelog.txt (newest first,
#    `## <version> — <date>`; a `!!` first line if permissions or data flow change — see below). Commit, then:
git tag v<version> && git push origin v<version>

# 2. .github/workflows/publish.yml builds from the tag (build, check:relay, dry-run listing) and STAGES the version
#    on npm via trusted publishing (OIDC; no token anywhere). CI can only stage — the trusted-publisher connection on
#    npmjs.com has "Allow npm publish" OFF.

# 3. on the maintainer's machine (npm >= 11.15; the only kind of machine holding ~/.can2cup-release/release.json):
npx -y npm@latest stage list can2cup        # the stage-id of the waiting version; `stage view <id>` inspects the tarball
npx -y npm@latest stage approve <id> --auth-type=web   # 2FA → the version is live on the registry
npm run release:relay        # routes-check → download THAT tarball from npm → sign its hash into dl/manifest.json → wrangler deploy
npm run release:relay:local  # emergency variant: stage the locally packed tarball instead (npm down); then `npm run release:npm` by hand

# 4. a GitHub Release for the tag, with the changelog entry as its body:
node scripts/gh-release.mjs v<version>     # extracts the entry from changelog.txt and runs `gh release create`
```

`can2cup upgrade` on every client then downloads from npm (or `--from-relay`) and installs only if the tarball's hash
is in the signed manifest. `relay-assets/dl/` (VERSION, VERSION.sha256, manifest.json, manifest.sig and the tarballs) is
what `release:relay` rewrites and deploys; the tarballs themselves are gitignored, the small files are committed.

Do not leave a tag that never shipped: a tag either goes through step 3 or the next version absorbs it and the tag is
deleted.

## Signed releases

Every release ships `/dl/manifest.json` + `/dl/manifest.sig`, signed with a key that lives only on the maintainer's own
machines — not on the relay, not in CI, not in any secret store. More than one of those machines holds it, so a release
can be cut from either; the property this buys is that no relay operator and no CI job can produce the signature.
`can2cup upgrade` refuses to install unless the manifest verifies against a release key compiled into the client
(`src/protocol/release.ts`; `can2cup doctor` prints them), names the same version as `/dl/VERSION`, and lists the hash
of the tarball it downloaded. `npm run release:key` mints a key; adding one means shipping a client that trusts it.
Design record: [security/2026-09-05-g3-tarball-signing.md](security/2026-09-05-g3-tarball-signing.md).

The repository is public, so the workflow's `npm stage publish` step passes `--provenance` and npm shows the build
attestation ("built on GitHub Actions from this commit") next to the signed manifest.

## The changelog and the `!!` rule

`relay-assets/changelog.txt` is served at `<relay>/changelog.txt` and read by agents, so it is machine-readable enough:
one `## <version> — <date>` line per release, bullets below, newest first. A version that was built but never
published on its own is folded into the next entry and says so.

> A release that changes **who may do what** or **where data goes** says so on the first line of its entry —
> `!! PERMISSION CHANGE: …` and/or `!! DATA FLOW: …` — above the bullets.

Agents are told (SKILL §3.5) to quote those lines to their principal before running `can2cup upgrade`: a flagged
release is never a silent upgrade, patch or not. Relay-side changes are in effect for every client the moment the relay
is deployed, whatever version is installed; the flag still goes on the entry so the principal hears about it from the
same place. Any change of default relay hostname is announced there too.

## What a release must pass

Before cutting from `main`: `npm run build`, `npm run check:relay`, `check:pii`, `check:i18n` (CI runs these two
again), the smoke against a local relay, `check:chat` if any chat text or bridge logic changed, and `check:routes`. After `release:relay`: `npm run probe:prod`. The shipped surface
is the `files` list in `package.json` (`dist` minus `dist/scripts`, `README.md`, `SKILL.md`, `INSTALL.zh-tw.md`,
`LICENSE`, `NOTICE`, `src/relay`, `src/protocol`, `tsconfig.relay.json`, `wrangler.toml`, `docs/SELF-HOST.md`) — the
workflow's dry-run step prints what would ship.
