// v0.17.0: the languages a boss may choose — ONE whitelist, shared by the relay (what /lang accepts, what the bot
// speaks) and the client (what it tells the agent). A language travels the unsigned chat path, so it is only ever one
// of these codes, never free text: `/lang` must not become a way to put words into the agent's prompt. Everything the
// agent reads about a language (its name, how to address the boss, the role words) comes from this table, never from
// the value that arrived.

export interface LangInfo {
  code: string;
  /** English name, for the lines the agent reads. */
  name: string;
  /** The language's own name, for the picker and for people. */
  native: string;
  /** How the agent addresses its boss in this language; absent = their name, politely. */
  address?: string;
  /** Role words an agent may use to introduce itself: what the boss can hand it. Roles, not titles. */
  roles: string;
}

/** The order is the picker's (the first twelve are buttons; Telegram's inline keyboard takes twelve, LINE thirteen). */
export const LANGS: readonly LangInfo[] = [
  { code: "en", name: "English", native: "English", address: "boss", roles: "a secretary, an assistant, your right hand" },
  { code: "zh-TW", name: "Traditional Chinese (Taiwan)", native: "繁體中文", address: "老闆", roles: "秘書、特助、業助、夥計" },
  { code: "ja", name: "Japanese", native: "日本語", roles: "秘書、アシスタント、営業アシスタント、右腕" },
  { code: "th", name: "Thai", native: "ไทย", address: "บอส", roles: "เลขา, ผู้ช่วย, ผู้ช่วยฝ่ายขาย, มือขวา" },
  { code: "id", name: "Indonesian", native: "Bahasa Indonesia", address: "bos", roles: "sekretaris, asisten, asisten sales, tangan kanan" },
  { code: "vi", name: "Vietnamese", native: "Tiếng Việt", address: "sếp", roles: "thư ký, trợ lý, trợ lý kinh doanh, cánh tay phải" },
  { code: "ko", name: "Korean", native: "한국어", address: "사장님", roles: "비서, 어시스턴트, 영업 지원, 오른팔" },
  { code: "zh-CN", name: "Simplified Chinese", native: "简体中文", address: "老板", roles: "秘书、助理、业务助理、得力助手" },
  { code: "ru", name: "Russian", native: "Русский", roles: "секретарь, ассистент, помощник по продажам, правая рука" },
  { code: "es", name: "Spanish", native: "Español", address: "jefe", roles: "asistente, asistente comercial, mano derecha" },
  { code: "pt-BR", name: "Portuguese (Brazil)", native: "Português (BR)", address: "chefe", roles: "assistente, assistente comercial, braço direito" },
  { code: "hi", name: "Hindi", native: "हिन्दी", roles: "सचिव, सहायक, सेल्स असिस्टेंट, दाहिना हाथ" },
  { code: "uk", name: "Ukrainian", native: "Українська", roles: "секретар, асистент, помічник з продажів, права рука" },
  { code: "ar", name: "Arabic", native: "العربية", roles: "سكرتير، مساعد، مساعد مبيعات، ذراعك اليمنى" },
  { code: "de", name: "German", native: "Deutsch", address: "Chef", roles: "Assistenz, Vertriebsassistenz, rechte Hand" },
  { code: "fr", name: "French", native: "Français", address: "patron", roles: "secrétaire, assistant, assistant commercial, bras droit" },
];

/** Nothing chosen and the platform names no language we know: English. */
export const DEFAULT_LANG = "en";
/** What an account bound before languages existed speaks: every one of them was onboarded in Traditional Chinese. */
export const LEGACY_LANG = "zh-TW";

export function langInfo(code: unknown): LangInfo | undefined { return LANGS.find((l) => l.code === code); }
export const isLang = (code: unknown): code is string => !!langInfo(code);

/** A platform locale ("zh-TW", "zh-hant", "en-US", "pt_BR"), a typed code or a language's name → one of LANGS. */
export function normLang(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().replace(/_/g, "-").toLowerCase();
  if (!s || s.length > 32) return undefined;
  const exact = LANGS.find((l) => l.code.toLowerCase() === s || l.native.toLowerCase() === s || l.name.toLowerCase() === s);
  if (exact) return exact.code;
  if (s.startsWith("zh-hant") || /^zh-(tw|hk|mo)\b/.test(s)) return "zh-TW";
  if (s === "zh" || s.startsWith("zh-")) return "zh-CN";
  const base = s.split("-")[0];
  if (base === "pt") return "pt-BR";
  if (base === "in") return "id"; // the old ISO code some platforms still send
  return LANGS.find((l) => l.code === base)?.code;
}
