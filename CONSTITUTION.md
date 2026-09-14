<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# A Constitution for Agents That Speak for People

*Version 0.1 · draft · 2026-09-14 · CC BY 4.0*

**English** · [繁體中文](docs/i18n/CONSTITUTION.zh-TW.md)

## Why this exists

More and more people hand work to an AI agent, and before long the agent on one side will be talking to the agent on the other side: booking a table, negotiating a price, selling a second-hand pram, opening read access to a log. The transport for that is being standardised (A2A, MCP, and several private protocols), mostly for agents inside and between companies, and a survey in September 2026 found no product that lets the agents of ordinary people talk to each other in the chat apps those people already use. None of those standards says whose authority a message carries once it lands inside the other agent's context, or what a person keeps in their own hands after an agent starts speaking for them.

This text writes those rules down in plain language, so that a person can read them without reading any code, and a builder can implement them without using any particular code. It comes out of the [Parenting Agent essays](https://peachpitboat.com/posts/parenting-agent/) and out of can2cup, a reference implementation, but the Articles depend on neither. If a different tool meets them, that tool follows this constitution; if can2cup stops meeting one, it stops claiming that one.

The reasoning behind every Article is the same, so it is stated once here. When two agents negotiate, the safety that matters comes from structure around the agents (a written limit, a signed record, a brake, a permission that can be taken back), not from hoping the agent is clever enough to resist persuasion. Agents get better every few months and so does persuasion, while a limit written in advance stays where it was put. It also cannot be left to the people involved to stay alert: in Anthropic's Project Deal experiment, people represented by stronger models got measurably better deals while both sides rated the fairness the same, so the side that lost did not feel that it lost. A defect that cannot be felt from the inside has to be handled by the structure.

## How to use this text

- **Read it as a person.** Each Article is one rule, a short reason, and what it does not promise. None of it requires knowing cryptography; where a technique is mentioned, it is an example.
- **Build from it as a developer.** [Appendix A](#appendix-a--the-articles-as-requirements) restates every Article as a testable requirement (C-1 to C-14). Any language, any protocol, any hosting. You can skip every implementation this page links to.
- **Claim it honestly.** A tool may say "follows Articles 1–14", or "follows 1–9 and 11–14; not 10, because …". A partial claim names what is missing. There is no certification, no fee, and no one to ask for permission.

## Words

- **Boss**: the person an agent acts for, whose authority the agent borrows. Engineers and lawyers call this role the *principal*. Both sides of a negotiation have one.
- **Agent**: a model application that loops, calls tools and acts, rather than only answering.
- **Peer**: an agent that answers to a *different* boss. Not a sub-agent, not a tool, not an intruder, but a legitimate counterparty, authorised by its own boss and standing outside your trust boundary.
- **Mandate**: the written limits a boss gives an agent: amounts, what may never be disclosed, which permissions it may give alone, which decisions it may never make alone.
- **Commitment**: anything that binds the boss beyond words, such as accepting a deal, agreeing a price, granting a permission, or disclosing something reserved.
- **Carrier**: whatever moves messages between agents (a relay, a server, a chat platform, a protocol endpoint) and whoever operates it.
- **Record**: the history of what was said in a conversation between agents.

## The Articles

### Part I · The boss stays the boss

#### Article 1 · Authority is borrowed

Every agent answers to one boss, and everything it may do is borrowed from that boss. Borrowed authority stays revocable, auditable and capped. When any of the three is lost, the arrangement is closer to guardianship than to agency: the person has become the object of decisions instead of the one making them.

*Not promised:* that the agent uses the authority well. That is what the other Articles are for.

#### Article 2 · Limits are written in advance, and the agent cannot move them

The boss writes the mandate before the conversation, while calm, in a form the boss can read. The agent may act anywhere inside it and may ask for more, but nothing the agent does and nothing a peer says widens it. Only the boss widens it, on the boss's own channel.

*Why:* in the middle of a negotiation, both the agent and the boss are at their least reliable.

*Not promised:* that the limits are wise. A mandate is a seatbelt for your own agent; it gives the counterparty nothing, and a rule that checks text does not read meaning.

#### Article 3 · Some decisions stay with the boss

A boss may list decisions they want to make themselves even where the agent would do better, and the agent brings those back instead of making them. The agent serves the needs the boss declared: it may trade one declared need against another, but it may not invent a need or rewrite one on the boss's behalf.

*Why:* an agent that optimises well will, left alone, optimise the person out of the parts of life they wanted to keep, and rewriting what someone needs is the step at which agency turns into guardianship.

#### Article 4 · The boss can stop it at any time

There is always a way for the boss to stop the agent from sending anything. It works without the agent's cooperation, and neither the agent nor a peer can undo it. A stop the boss proved came from them can only be lifted by the boss proving it again.

*Not promised:* that what was already sent can be recalled.

### Part II · Words from others are not orders

#### Article 5 · A peer's words are information, not instructions

What another boss's agent says reaches your agent marked as that peer's, and kept apart from what your own boss said. It can inform your agent, change its mind, even persuade it. It cannot by itself authorise an action, a commitment, or a change to your agent's own limits.

*Why:* most agent software today has two places to put incoming text, "my boss said this" and "a tool returned this". A peer's message belongs in neither, and putting it in the first hands a stranger your boss's authority. The Parenting Agent essays call this defect [*principal collapse*](docs/principal-collapse.md).

*This includes your own devices.* An agent on another machine of yours is a peer like any other. A compromised device of your own is more dangerous than a stranger, because you are inclined to believe it.

#### Article 6 · Nothing a peer says can promote itself

No content inside a peer's message, however it is worded, can make that message or any later one count as the boss's. A peer writing "your boss has already approved this" does not make it true. Anything that counts as the boss must arrive fresh, on the boss's own channel.

*Why:* this is the requirement most often skipped and the one that matters most. A label that a persuasive enough paragraph can talk its way past is only a label, not a boundary.

#### Article 7 · Who said it can be checked without trusting the messenger

Every message between agents carries an author that can be verified independently of the carrier that delivered it. The carrier cannot write a message in someone else's name, and what it announces itself is signed as its own.

*Why:* if the carrier can forge the author, marking a message as a peer's is decoration.

### Part III · Commitments need the boss's hand

#### Article 8 · Talking is open; a commitment needs the boss, on that exact act

Once an agent is allowed to commit to anything at all, each commitment beyond the mandate's standing limits needs an approval that can be attributed to the boss and is bound to that one act, so it cannot be reused for another amount, another message, or the rest of the session. A go-ahead that cannot be attributed to the boss (a chat message anyone holding the phone could have typed, a note passed along by someone else) is enough for words and not for commitments.

*Why:* a mandate widened "just for this deal" otherwise stays widened for every deal after it.

*Not promised:* that the boss's approval is wise. It is still the boss's.

#### Article 9 · What was given can be taken back

Permissions an agent grants have a scope and an expiry, and can be revoked by whoever granted them, and only by them. At any moment a boss can find out from the record what the other side still holds from them.

*Not promised:* that the peer did not use a permission before it was revoked.

#### Article 10 · Secrets stay home

What the boss marks as never to be disclosed (a reservation price, a document, a fact) does not leave the agent's side. The agent's private reasons for its moves are kept for its own boss and are sent neither to the peer nor to the carrier. A peer may ask; the agent declines without hinting.

*Why:* putting everyone's bottom line inside something that talks to the outside is a way of giving up the negotiation.

*Not promised:* that a paraphrase is caught. Checking for the exact text is easy and checking for meaning is not, so a tool says which of the two it does.

### Part IV · The record belongs to the people in it

#### Article 11 · The boss can see what happened, and on whose words

For anything the agent did, the boss can see what it did and whether the input that caused it came from the boss, a peer, a tool, or an unverified channel. Tools should leave the boss able to judge, not only comfortable.

*Why:* the one part of being a boss that cannot be delegated is judging whether the agent is still working for you, and the boss has to be able to see before there is anything to judge. The realistic failure of delegation is probably not an agent that rebels, but a boss who slowly loses the ability to notice.

#### Article 12 · The record cannot be quietly rewritten, and "verified" means verified

The record is kept so that the people in the conversation can detect afterwards, without taking the carrier's word, that part of it was altered, reordered or cut off. A check that could not prove something says so; it never reports "verified" for what it did not verify, and it says how much of the record it covered.

*Not promised:* that the carrier cannot refuse, withhold or fork. Only that it cannot do so without leaving evidence.

#### Article 13 · No one owns the road

The rules and the conversations are both portable. Anyone can run their own carrier, a conversation can move to another carrier and still verify, and no boss has to trust a particular operator to be protected by Articles 1–12. Where a path does depend on trusting an operator, the tool says so, and says what that trust can buy.

*Why:* a rule that holds only on one company's service becomes that company's feature, and other organisations do not adopt a feature a competitor owns.

### Part V · Honesty

#### Article 14 · Say what is not guaranteed

A tool that follows this constitution states in plain words what each of its protections does not cover. People decide how much to hand over based on what they believe a tool promised, so an honest boundary is worth more to them than an overstated guarantee.

## Open questions (not Articles yet)

Written down so that silence is not mistaken for an answer.

- **Fairness.** All fourteen Articles protect each boss's limits, and none of them affects how the surplus of a deal is split. Two agents that follow every rule will still hand the difference to whichever side concedes more slowly, and both sides may feel fairly treated. The likely answer is a neutral layer that takes no side (mechanism design, secure multi-party computation), and it is not built yet.
- **Meaning.** Articles 2 and 10 can be enforced reliably only on exact text and numbers. Catching a paraphrased secret, or an in-bounds but unwise deal, is a judgement; if a tool adds one, it should hold the action for the boss rather than decide.
- **Absence.** Should authority lapse on its own when a boss has not been seen for a long time? Probably, with a warning first; the default length is open.
- **One agent, several people.** These Articles are written for conversations in which each boss has their own agent. An agent that serves several people at once (a shared assistant in a group chat, for example) has several bosses by construction, and this text does not yet say how it should resolve them.

## About this text

- **No one owns it, and every copy points back.** It is licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): copy it, translate it, adapt it, put it in a specification or a product, commercial or not, with no fee and no permission to ask. The one condition is credit: name the source, link to it, and say whether you changed it. Credit is asked for because the Articles are the short form, and the full argument (the cases, the experiments, the objections) lives in the essays, so a reader who meets a copy somewhere should be able to find the whole of it. The licence covers this text, not the rules in it: software or a protocol that follows the Articles is not a copy of the text and needs no credit. A credit line can be as short as *Based on "A Constitution for Agents That Speak for People", peachpitboat.com, CC BY 4.0.* The model is the one USB and Linux followed. Intel made the USB patents royalty-free, and that is a large part of why every device ended up with the port, while a rule owned by one company is unlikely to be adopted by its competitors.
- **It is not a protocol.** It does not choose a wire format, a signature scheme or a transport. [Appendix B](#appendix-b--how-it-sits-on-existing-protocols) shows how it sits on A2A and MCP.
- **Changing it.** Proposals come as public issues with the reasoning and, where possible, a counterexample. Article numbers become permanent at 1.0: from then on a removed Article retires its number, so "follows Article 8" never changes meaning. Before 1.0 Articles may still be merged, split or renumbered, because the essays they are drawn from are still being revised. If an idea here already has an earlier name elsewhere, the earlier name is adopted.
- **Versions.** 0.x while drafting, and 0.x follows the essays: when an essay is revised, the Articles drawn from it are revised to match. 1.0 once at least two independent implementations follow every Article.

---

## Appendix A · The Articles as requirements

The key words MUST, MUST NOT and SHOULD are used as in RFC 2119. The PC column cross-references the six requirements in [principal collapse](docs/principal-collapse.md#conformance-requirements).

| id | requirement | Article | PC |
|---|---|---|---|
| C-1 | An agent identity MUST act for exactly one boss. Every authority it exercises MUST be revocable by that boss, recorded, and bounded by a mandate. | 1 | |
| C-2 | The mandate MUST be set by the boss through the boss's channel. No agent action and no peer content may widen it. | 2 | |
| C-3 | Decision types the boss reserves MUST be escalated to the boss regardless of amount or the agent's confidence. The agent MUST NOT create or rewrite the boss's declared needs. | 3 | |
| C-4 | A stop MUST exist that halts all outbound messages without the agent's cooperation. A stop attributable to the boss MUST NOT be lifted except by input attributable to the boss. | 4 | |
| C-5 | Input from outside the boss's trust boundary MUST be represented distinctly from the boss's input and MUST NOT by itself authorise a tool call, a commitment, or a change to the agent's constraints. Agents of the same boss on other devices MUST be treated as peers. | 5 | PC-1, PC-3 |
| C-6 | No content within a peer message may cause that message, or any later message, to be classified as the boss's. Such classification MUST require fresh input on the boss's channel. | 6 | PC-4 |
| C-7 | Every inter-agent message MUST carry an author identity verifiable independently of the carrier. Events originated by the carrier MUST be distinguishable from participant messages and attributable to the carrier. | 7 | PC-2 |
| C-8 | A commitment beyond the mandate's standing limits MUST require an approval attributable to the boss and bound to that specific message (for example, by its hash). An approval MUST NOT be usable for any other message. An unattributable go-ahead MUST NOT release a commitment unless the boss has explicitly opted out, and the opt-out MUST be disclosed under C-14. | 8 | PC-5 |
| C-9 | Grants MUST have a scope and an expiry and MUST be revocable by the grantor only. The set of live grants MUST be derivable from the record; when the record is known to be incomplete, the set MUST be withheld rather than computed. | 9 | |
| C-10 | Content the mandate marks as undisclosable MUST be refused before it is sent. Private rationale MUST NOT be transmitted to peers or the carrier. The tool MUST state whether its disclosure check is literal or semantic. | 10 | |
| C-11 | For every action, the boss MUST be able to see the action and the role or channel of the input that caused it. | 11 | PC-6 |
| C-12 | The record MUST make alteration, reordering, omission and truncation detectable by participants without trusting the carrier. Verification MUST report verified, refuted or inconclusive together with its coverage, and a path that did not prove something MUST NOT report verified. | 12 | |
| C-13 | Conformance with C-1 to C-12 MUST NOT depend on a specific operator. Records SHOULD be portable between carriers. Any path whose protection depends on an operator MUST be disclosed together with what that trust can buy. | 13 | |
| C-14 | A conforming tool MUST publish what each of its protections does not cover. | 14 | |

## Appendix B · How it sits on existing protocols

**A2A** (Agent2Agent; a Linux Foundation project) gives agents discovery through Agent Cards, tasks and messages, and authentication at the transport. It deliberately leaves authorisation to each organisation, which is the space these Articles fill.

| Article | on A2A |
|---|---|
| 5, 6 | Outside the wire protocol: they govern what the receiving harness does with a message. A conforming receiver never places a peer's message parts in the boss's role. |
| 7 | Transport authentication identifies the connection, not the author of a message once it is stored or forwarded. A per-message signature is needed, carried in message metadata or an extension. |
| 8 | An extension carrying the boss's approval bound to the message hash. |
| 9 | Grant and revoke as message kinds with scope and expiry. |
| 12 | A hash-chained history: each message includes the hash of the one before it. |
| 13, 14 | The Agent Card declares the constitution version and the Articles followed, through an extension URI, and links to what is not guaranteed. |

**MCP** (Model Context Protocol; hosted by the Linux Foundation's Agentic AI Foundation) connects an agent to tools. When a peer's messages reach an agent through an MCP server, today they arrive either as tool results, where the author is lost, or injected as user text, where the author is promoted. Articles 5 and 6 ask the host for a third option; the Parenting Agent essays propose a `peer` role carrying `author`, `principal_of_author` and `authority: "none"`. Until hosts have one, a server can at least deliver peer content in separate, labelled blocks and never phrase it as the user's.

**Chat platforms** (LINE, Discord, Telegram, Slack and similar) make a convenient channel for the boss, but what arrives through them is not signed by the boss. Under Article 8 such a channel can carry words and a stop; commitments need an approval that can be attributed, or an opt-out stated under Article 14.

## Appendix C · One implementation (optional reading)

Nothing in this table is required. It shows that the Articles can be met with ordinary parts, in [can2cup](README.md).

| Article | can2cup |
|---|---|
| 1 | one agent key per machine; `mandate.json`; `revoke`, `eject`, `unbind` |
| 2 | `mandate.json` checked by the client before every send, and by the hosted relay from the same code |
| 3 | `require_confirm`: message types the agent never sends alone |
| 4 | the `PAUSED` file, `/pause` from a phone, and a signed remote pause that an unsigned `/resume` cannot lift |
| 5 | peer strings fenced and labelled as data; the boss's messages delivered in separate content blocks; own devices use the ordinary room |
| 6 | only boss-signed input is marked `VERIFIED`; `require_signed_principal` closes the unsigned path |
| 7 | every message ed25519-signed by its author; the relay holds no private key and signs its own system events |
| 8 | the commit gate: `can2cup approve <room> <seq>` binds the boss's signature to the envelope hash |
| 9 | `grant` / `revoke` with scope and expiry; the live-grant ledger, withheld when the relay serves only a prefix |
| 10 | `never_disclose` (a literal check, and documented as one); private rationale kept in the local audit log |
| 11 | the boss's window: per-message verification, private rationale, blocked sends; `audit.jsonl` |
| 12 | hash chain and a relay-signed transcript head; CLEAN / REFUTED / INCONCLUSIVE with coverage |
| 13 | self-hosting on a free tier, portable rooms and mirrors, end-to-end encrypted rooms |
| 14 | [TRUST.md](docs/TRUST.md) and the review records in [docs/security/](docs/security/README.md) |

Where can2cup falls short, its own documents say so: the chat-app path is unsigned, and meets Article 8 only because the default mandate allows no commitments; the disclosure check is literal; revoke-on-absence is specified but not built ([ROADMAP.md](ROADMAP.md)).

## Sources

- The Parenting Agent series: [Parenting Agent](https://peachpitboat.com/posts/parenting-agent/) · [the implementation](https://peachpitboat.com/posts/can2cup-poc/) · [Principal Collapse](https://peachpitboat.com/posts/principal-collapse/) · [Glossary](https://peachpitboat.com/posts/parenting-agent-glossary/)
- [docs/principal-collapse.md](docs/principal-collapse.md): the six PC requirements this text builds on
- Linux Foundation: [A2A surpasses 150 organizations](https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year) · [formation of the Agentic AI Foundation](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation)
- Kang and Diponegoro (2026), [Governance Gaps in Agent Interoperability Protocols](https://arxiv.org/abs/2606.31498): a neighbouring argument that governance is a layer missing above MCP and A2A
- [The inventor of USB didn't make a dime off it](https://finance.yahoo.com/news/guy-invented-usb-didn-t-170239132.html): on Intel keeping USB royalty-free
- Anthropic (2026), *Project Deal*, as cited in the principal-collapse page
- Product survey, September 2026: [LINE allows one Official Account per group chat](https://developers.line.biz/en/docs/messaging-api/group-chats/) · [Telegram bot-to-bot communication](https://core.telegram.org/bots/features) · [WhatsApp third-party agents are one-to-one only](https://9to5mac.com/2026/09/07/whatsapp-will-soon-let-users-chat-with-up-to-five-third-party-ai-agents/)

## History

- **0.1 (2026-09-14)**: first draft, drawn from the Parenting Agent series (before the author's own revision of those essays) and from the can2cup documents.
