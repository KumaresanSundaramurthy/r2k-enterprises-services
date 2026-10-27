import { Injectable } from "@nestjs/common";
import { CurlService } from "../curl/curl.service";

export type LangCode = "en" | "ta";

// What the user typed in one field, and the language it was typed in
export interface TypedText {
  text: string | null;
  lang: LangCode;
}

interface MyMemoryResponse {
  responseStatus?: number | string;
  responseData?: { translatedText?: string };
}

/** English ⇄ Tamil text handling (CI3 translation_helper: detectTextLang / translateViaMymemory). */
@Injectable()
export class TranslationService {
  constructor(private readonly curl: CurlService) {}

  // 'ta' when the text contains any Tamil character
  detectLang(text: string): LangCode {
    return /[஀-௿]/.test(text) ? "ta" : "en";
  }

  // MyMemory free API; returns the original text on any failure (fail-safe, as in CI3).
  async translate(text: string, from: LangCode, to: LangCode): Promise<string> {
    const input = text.trim();
    if (input === "" || from === to) return input;

    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(input)}&langpair=${encodeURIComponent(`${from}|${to}`)}`;
    const data = await this.curl.json<MyMemoryResponse>(url, { timeoutMs: 10000 });
    const translated = data?.responseData?.translatedText ?? "";
    if (translated === "" || Number(data?.responseStatus) !== 200) return input;

    // MyMemory sometimes prefixes proper nouns with "- "
    const cleaned = translated.replace(/^[-\s]+|[-\s]+$/g, "");
    return cleaned !== "" ? cleaned : input;
  }

  /**
   * One field typed by the user: `english` for the base table (Tamil input translated) and `typed`
   * (what was typed and its language) for the *_Lang row written later. Empty text → null.
   */
  async normalize(text: string | null | undefined): Promise<{ english: string | null; typed: TypedText }> {
    const value = text ?? "";
    if (value === "") return { english: null, typed: { text: null, lang: "en" } };
    const lang = this.detectLang(value);
    return { english: lang === "ta" ? await this.translate(value, "ta", "en") : value, typed: { text: value, lang } };
  }

  // Tamil for the *_Lang table: Tamil input is kept, English is translated.
  async toTamil(text: string | null | undefined, typedLang: LangCode): Promise<string | null> {
    if (text === null || text === undefined || text === "") return null;
    return typedLang === "ta" ? text : this.translate(text, "en", "ta");
  }

  async typedToTamil(typed: TypedText): Promise<string | null> {
    return this.toTamil(typed.text, typed.lang);
  }
}
