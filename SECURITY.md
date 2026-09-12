# Security

can2cup's whole point is that the guarantees are structural and written down. If you find a way the enforcement is
weaker than the words, that is exactly the kind of report we want.

## Reporting

- **Preferred**: a private report through GitHub — *Security → Report a vulnerability* on this repository. Nobody but the maintainer sees it until it is fixed and published.
- **From an installed client**: `can2cup report "<what you found>"` sends a diagnostic (versions, OS, doctor output,
  your text — never room content) to the operator of the relay you are configured against. Good for "the relay
  refused my upgrade" or "the manifest does not verify"; use GitHub for anything that should stay private.
- Please do not open a public issue for an exploitable finding until it is fixed.

Expect an acknowledgement within a few days. There is no bounty; there is credit in the fix's changelog entry and in
`docs/security/` if you want it.

## Scope

- `src/protocol/` — signatures, hash chain, invite tokens, mandate and commit gate, release-manifest verification.
  This is the audited surface; a hole here is the highest severity.
- `src/mcp/` and `src/cli/` — the client: state on disk, inbox handling, framing of peer-controlled strings, the pause
  check, upgrade verification.
- `src/relay/` — the Worker and Durable Objects: room access (invite secret, caps, rotate / eject), the principal
  bridge, the three chat-app adapters (webhook verification, command parsing), quotas, the remote MCP connector and
  OAuth, A2A ingest.
- The release pipeline — `.github/workflows/publish.yml`, `scripts/release-*.mjs`, `relay-assets/dl/`.

Out of scope: the chat platforms themselves, Cloudflare, npm; the `demo/` prototypes (they are not shipped and say so);
denial of service against `can2cup.com`, which is a demo deployment with no availability promise.

## What is already known and accepted

The trust model names its residuals on purpose — read [docs/TRUST.md](docs/TRUST.md) before reporting one of these as
new: the chat-app path is unsigned (trust ceiling = relay operator, bounded by the mandate and the commit gate); the
relay can withhold or fork (not preventable; provable once a client holds a later signed head or the two sides compare
what they saw); `never_disclose` is a literal substring scan; the brake is
checked at most every 5 s; the `/link` code proves receipt, not identity.

## Reviews so far

Every adversarial review, what it found and which release closed it: [docs/security/README.md](docs/security/README.md).
Each finding names the attacker, the precondition, what they get, and which hostnames and client versions it affects.
