/**
 * v0.17.0: the console's words, in the boss's language.
 *
 * gettext-shaped on purpose: the Traditional Chinese sentence stays in the code, where it is written and read, and is
 * also the key a translation is filed under (src/relay/i18n/<lang>.json). A translator sees the whole sentence, never
 * an opaque id; a sentence that changes in the code loses its translation, and `npm run check:i18n` says which.
 *
 * `{name}` placeholders are filled from `vars` in ONE pass over the template, so a value (a group's name, a peer's
 * words) is inserted verbatim and never read as a placeholder itself.
 *
 * The console speaks Traditional Chinese (the source) and every language with a catalog below; any other language gets
 * English here — the agent still speaks the boss's own language, which is a different, larger list (protocol/lang.ts).
 * A new language is one JSON file with the same keys and one line in CATALOGS; `npm run check:i18n` lists the gaps.
 */
import EN from "./i18n/en.json";
import ZH_CN from "./i18n/zh-CN.json";
import JA from "./i18n/ja.json";
import TH from "./i18n/th.json";
import ID from "./i18n/id.json";
import VI from "./i18n/vi.json";

export type Vars = Record<string, string | number | null | undefined>;

const CATALOGS: Record<string, Record<string, string>> = { en: EN, "zh-CN": ZH_CN, ja: JA, th: TH, id: ID, vi: VI } as Record<string, Record<string, string>>;

/** The languages the console itself speaks, source first. */
export const BOT_LANGS: readonly string[] = ["zh-TW", ...Object.keys(CATALOGS)];

/** The language the console itself answers in, for a boss who chose `lang`. */
export function botLang(lang: string | undefined): string {
  if (lang === "zh-TW") return "zh-TW";
  if (lang && CATALOGS[lang]) return lang;
  return "en";
}

export function tr(lang: string | undefined, zh: string, vars?: Vars): string {
  const l = botLang(lang);
  const tmpl = l === "zh-TW" ? zh : (CATALOGS[l]?.[zh] ?? zh);
  if (!vars) return tmpl;
  return tmpl.replace(/\{(\w+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k] ?? "") : m));
}

/** One word or phrase that lives outside a tr() call — the chat apps' own words (channel.ts vocabIn). Its keys are
 *  found by check:i18n in the adapters' `vocab` objects, so they are translated like every sentence. */
export function translateWord(lang: string | undefined, zh: string): string {
  const l = botLang(lang);
  return l === "zh-TW" ? zh : (CATALOGS[l]?.[zh] ?? zh);
}
