import { expect, test } from "vitest";
import { chunkText } from "../../../src/channels/wechat/text.js";

test("short text is one chunk", () => {
  expect(chunkText("  hello  ", 10)).toEqual(["hello"]);
});

test("prefers paragraph, then line, then word breaks", () => {
  expect(chunkText("aaaa bbbb\n\ncccc", 12)).toEqual(["aaaa bbbb", "cccc"]);
  expect(chunkText("aaaa bbbb\ncccc dd", 12)).toEqual(["aaaa bbbb", "cccc dd"]);
  expect(chunkText("aaaa bbbb cccc", 12)).toEqual(["aaaa bbbb", "cccc"]);
});

test("text without breaks is cut hard without splitting a surrogate pair", () => {
  const text = `${"a".repeat(9)}😀${"b".repeat(5)}`;
  const chunks = chunkText(text, 10);
  expect(chunks).toEqual(["a".repeat(9), `😀${"b".repeat(5)}`]);
  expect(chunks.join("")).toBe(text);
});
