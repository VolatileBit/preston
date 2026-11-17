import { z } from "zod";

/**
 * The languages Preston can talk to the user in. English is the source language; Simplified
 * Chinese is a secondary option. Everything Preston itself says to the user (fixed replies,
 * Goal messages, setup guides) and the Coordinator's own replies follow this setting. Text
 * written for agents (Briefs, Worker prompts, commit messages) stays English.
 */
export const LANGUAGES = ["en", "zh-CN"] as const;
export const languageSchema = z.enum(LANGUAGES);
export type Language = z.infer<typeof languageSchema>;

export const LANGUAGE_NAMES: Record<Language, string> = { en: "English", "zh-CN": "简体中文" };

// One Preston runs per process, for one user, so the language is process-wide state that the
// runtime keeps in step with `config.language`. Message builders read it when they speak.
let current: Language = "en";

export function setLanguage(language: Language): void {
  current = language;
}

export function language(): Language {
  return current;
}

/** The text for the current language. */
export function pick<T>(text: { en: T; "zh-CN": T }): T {
  return text[current];
}

/** The language a computer's locale suggests, for the first-run question. */
export function languageFromLocale(locale: string | undefined): Language {
  return /^zh([_-]|$)/i.test(locale ?? "") ? "zh-CN" : "en";
}

/** Appended to the Coordinator's guidance when it must not speak English. */
export function coordinatorLanguageGuidance(lang: Language): string {
  if (lang === "en") return "";
  return `Language
- The user has chosen Simplified Chinese (简体中文). Write every reply, question, setup instruction and Brief summary you show them in Simplified Chinese, in the same plain, warm tone. Keep commands, file paths, URLs, code, tokens and product names (Discord, Slack, Claude Code, Codex) exactly as they are.
- Briefs, tool inputs and anything written for agents stay in English. Only what the user reads is in Chinese.
- If the user asks for English, call config_update with {"language": "en"} and switch.`;
}
