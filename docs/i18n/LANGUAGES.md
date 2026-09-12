# README translations — which languages, and why these

**Published now: English (the source of truth, `README.md`), Traditional Chinese and Simplified Chinese**
(`docs/i18n/README.zh-TW.md`, `README.zh-CN.md`). The other thirteen below were written on 2026-09-11 and are parked
until the documents settle: keeping fifteen translations in step while the English still changes every day costs more
than it returns. They are in the git history (removed in the commit after 170b5b9) and come back by regenerating each
from the English file, whole, once it is stable. The survey below is why these languages, and stays for that day.

This is about documents only. The product keeps its languages: the agent speaks all sixteen (its prompt is English and
it is told the boss's language), and the bot speaks seven (see the end of this file). The guide is at
can2cup.com/guide (Traditional Chinese) and can2cup.com/guide/en (English). A translated README is a front door, not a
translated product.

The set was chosen from where the three chat apps can2cup speaks (LINE, Discord, Telegram) have the most users, so that
a person who already lives in one of those apps can read what this is. Surveyed 2026-09-11; the figures are the
sources' own and mix monthly-active users, downloads and traffic shares — read them as orders of magnitude.

## Where each app's users are

| app | largest markets (users) | source |
|---|---|---|
| **LINE** | Japan 98 M · Thailand 54 M · Taiwan 22 M · Indonesia 4 M (MAU, LY Corporation reports via [expandedramblings](https://expandedramblings.com/index.php/line-statistics/), 2025); other trackers give Indonesia 13–30 M | LY Corp FY2025 appendix |
| **Telegram** | India 84–104 M · Russia 34–35 M · Indonesia 24–27 M · United States 27–30 M · Brazil 22–23 M · Vietnam 12–18 M · Egypt 15 M · Mexico 12 M · Ukraine 11–12 M · Turkey 10 M · Kazakhstan 9 M · France 7.5 M · UK 6 M · Malaysia 5.5 M · Italy 4 M; penetration: Russia 51 %, India 45 %, Brazil 38 %, Mexico 34 %, Spain 32 % | [worldpopulationreview](https://worldpopulationreview.com/country-rankings/telegram-users-by-country) (Feb 2026 poll), [demandsage](https://www.demandsage.com/telegram-statistics/) |
| **Discord** | United States 28 % of traffic (226 M) · Brazil 6.5 % (52 M) · India 5.3 % (42 M) · UK 3.5 % (28 M) · Germany 3.3 % (26 M); then Russia, France, Canada, Japan, Philippines, Turkey, Mexico | [worldpopulationreview](https://worldpopulationreview.com/country-rankings/discord-users-by-country) (SEMrush traffic, Oct 2025), [demandsage](https://www.demandsage.com/discord-statistics/) |

## The languages, and what each one covers (all but zh-TW and zh-CN parked for now)

| file | language | covers | why |
|---|---|---|---|
| `README.zh-TW.md` | 繁體中文 | Taiwan (LINE 22 M, 92 % penetration) | the bot's home market; the only market where the whole product is in the reader's language |
| `README.ja.md` | 日本語 | Japan (LINE 98 M, ~78 %) | LINE's largest market by far |
| `README.th.md` | ไทย | Thailand (LINE 54 M, ~79 %) | LINE's second market |
| `README.id.md` | Bahasa Indonesia | Indonesia (Telegram 24–27 M, LINE 4–30 M depending on source) | large on both LINE and Telegram |
| `README.hi.md` | हिन्दी | India (Telegram 84–104 M, Discord 42 M) | the largest Telegram market; developers there read English, so this is a courtesy door, not the main one |
| `README.vi.md` | Tiếng Việt | Vietnam (Telegram 12–18 M) | Telegram is a primary messenger there |
| `README.ko.md` | 한국어 | South Korea (Discord and Telegram sizeable; LINE's parent Naver is Korean, but KakaoTalk dominates messaging) | Discord / Telegram readers, and the LINE lineage |
| `README.zh-CN.md` | 简体中文 | Malaysia, Singapore (Telegram 5.5 M+), the Chinese-reading diaspora | the three apps are blocked in mainland China; this serves the Chinese-reading Telegram markets around it |
| `README.ru.md` | Русский | Russia (Telegram 35 M, 51 % penetration; Discord ~40 M), Kazakhstan, Belarus, Central Asia | Telegram's home turf |
| `README.uk.md` | Українська | Ukraine (Telegram 11–12 M) | Telegram is the primary news and messaging channel there; not served by Russian |
| `README.ar.md` | العربية | Egypt (Telegram 15 M), the Gulf, the Maghreb | the largest Arabic Telegram market; rendered RTL |
| `README.pt-BR.md` | Português (BR) | Brazil (Discord 52 M, Telegram 23 M, 38 % penetration) | Discord's second market and a top-five Telegram one |
| `README.es.md` | Español | Mexico (Telegram 12 M, 34 %), Spain (32 %), Latin America (Discord) | two large Telegram markets and Discord's Spanish-speaking base |
| `README.de.md` | Deutsch | Germany (Discord 26 M), Austria, Switzerland | Discord's fifth market |
| `README.fr.md` | Français | France (Discord top-ten, Telegram 7.5 M), Canada, francophone Africa | Discord and Telegram both |

English covers the United States (the largest Discord and a top-four Telegram market), the UK, Canada, Australia,
the Philippines, Malaysia and Singapore, and India's developer audience.

**Considered and not done**: Turkish (Telegram 10 M, Discord notable — the next candidate); Italian (Telegram 4 M);
Persian (Telegram is dominant in Iran, but there are no reliable figures and can2cup.com is a personal deployment
that makes no availability promise there); Filipino (English is the working language of Philippine developers).

## Keeping them in sync

The English README changes; the translations lag. Rules:

- A translation is regenerated from the English file, whole, not patched sentence by sentence — the files are short.
  Each carries an italic line under its title saying the English README is the source of truth.
- Links and image paths in a translation are relative to `docs/i18n/` (`../CLIENT.md`, `../img/…`, `../../ROADMAP.md`).
- The language bar at the top of every file lists every language; the current one is bold and unlinked.
- Do not translate code, commands, file names, message types, or the product name.
- The person an agent answers to is **老闆** (zh-CN **老板**) in Chinese: the word people in Taiwan use for
  whoever is on the business side of a deal, and one both sides of a negotiation use for each other. Never 主人,
  委託人 or any word that means master or owner.
- In the README and anything else written for people, that person is the **boss**; the first mention reads "the
  agent's boss (the *principal*, …)", after that just boss. *Principal* is the engineering and academic term for the
  same role and stays in the technical documents (SKILL.md, TRUST.md, docs/security/, code). The colloquial word
  per language: 老闆 / 老板 · ボス · 사장님 · บอส · sếp · bos · बॉस · босс · бос · المدير · chefe · jefe · Chef · patron.
- A new language: add the file, add it to the bar in every other file, add a row here with the market it serves.

## The product, not only its README

The README translations above are documents. The product speaks too, in two layers (v0.17.0):

- **The agent** speaks every language in `src/protocol/lang.ts` (the same sixteen). Its prompt stays in English — one
  set of safety rules, not sixteen drifting ones — and it is told the boss's language (`/lang` in the chat app) and
  speaks it, addressing the boss with the word from the table above.
- **The bot** (the chat-app console) speaks Traditional Chinese, the source written in the code, and English,
  Simplified Chinese, Japanese, Thai, Indonesian and Vietnamese from `src/relay/i18n/<code>.json` (the chat apps' own
  words included). A further language is one more file there with the same keys, and
  one line in `src/relay/i18n.ts`; `npm run check:i18n` lists what is missing. The 老闆 / boss rules above apply there.
