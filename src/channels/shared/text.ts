/**
 * Splits outgoing text into chunks no longer than `limit` UTF-16 code units.
 *
 * Cuts prefer, in order: a blank line, a line break, the end of a sentence, a space.
 * A code fence (```) left open by a cut is closed at the end of the chunk and reopened,
 * with the same info string, at the start of the next one, so chat clients keep rendering it.
 */
export function splitMessage(text: string, limit: number): string[] {
  if (limit < MIN_LIMIT) throw new RangeError(`limit must be at least ${MIN_LIMIT}`);
  const chunks: string[] = [];
  let rest = text.replace(/\r\n/g, "\n").trim();
  let openFence: string | null = null;

  while (rest.length > 0) {
    const prefix = openFence ? `${openFence}\n` : "";
    if (prefix.length + rest.length <= limit) {
      chunks.push(prefix + rest);
      break;
    }
    const cut = findCut(rest, limit - prefix.length - FENCE_CLOSE.length);
    const piece = rest.slice(0, cut).trimEnd();
    const fenceAfter = scanFences(piece, openFence);
    chunks.push(prefix + piece + (fenceAfter ? FENCE_CLOSE : ""));
    rest = rest.slice(cut);
    // Inside a code block, keep indentation; in prose, drop the whitespace at the cut.
    rest = fenceAfter ? rest.replace(/^\n+/, "") : rest.trimStart();
    openFence = fenceAfter;
  }
  return chunks;
}

const FENCE_CLOSE = "\n```";
const MIN_LIMIT = 100;
const MAX_FENCE_OPENER = 20;

function findCut(text: string, max: number): number {
  const window = text.slice(0, max + 1);
  const candidates: Array<[RegExp, number]> = [
    [/\n[ \t]*\n/g, 0.4],
    [/\n/g, 0.4],
    [/[.!?。！？](?=\s)/g, 0.5],
    [/\s/g, 0.5],
  ];
  for (const [pattern, minFraction] of candidates) {
    let best = -1;
    for (const match of window.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (end <= max) best = end;
    }
    if (best >= max * minFraction) return best;
  }
  // No sensible boundary: hard cut, without splitting a surrogate pair.
  const code = text.charCodeAt(max - 1);
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
}

/** Returns the fence opener still open after `piece`, given the one open before it. */
function scanFences(piece: string, open: string | null): string | null {
  let current = open;
  for (const line of piece.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("```")) continue;
    // Clamp the info string so a pathological opener cannot eat the chunk budget.
    current = current ? null : trimmed.slice(0, MAX_FENCE_OPENER);
  }
  return current;
}
