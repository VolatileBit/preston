/** Shapes that are almost certainly credentials. Used to keep secrets out of saved text. */
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/,
  /\bxapp-[A-Za-z0-9-]{10,}/,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/, // Discord bot token
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i,
  /\b(?:password|passwd|passphrase|secret|api[_ -]?key|access[_ -]?token|auth[_ -]?token|token)\b\s*(?:is|=|:)\s*["']?[^\s"']{6,}/i,
  /\b[a-f0-9]{40,}\b/i, // long hex
];

/** Whether `text` appears to contain a credential. */
export function looksLikeSecret(text: string): boolean {
  if (SECRET_SHAPES.some((pattern) => pattern.test(text))) return true;
  // Long unbroken mixed-case/digit runs, such as base64 keys.
  for (const word of text.split(/\s+/)) {
    if (word.length >= 32 && /^[A-Za-z0-9+/_=-]+$/.test(word)) {
      if (/[A-Z]/.test(word) && /[a-z]/.test(word) && /\d/.test(word)) return true;
    }
  }
  return false;
}

export const SECRET_REFUSAL =
  "That looks like a password or access key, so I did not save it. Credentials never go into saved notes.";
