/**
 * Python `urllib.parse` equivalents for share-link bytes.
 *
 * WHY this module exists: share URIs are copied by users and compared in
 * tests, and Python's `quote` and JS `encodeURIComponent` disagree on
 * `!'()*` (Python encodes them, JS does not). `share_service` calls
 * `urlencode(params, quote_via=quote, safe="")` and `quote(remark, safe="")`,
 * so both are reproduced here with Python's always-safe set
 * (`A-Za-z0-9_.-~`) and uppercase `%XX` over UTF-8 bytes.
 */

import { pyStr } from "./python_json";

const ALWAYS_SAFE =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-~";

/**
 * WHAT: percent-encode one string exactly like Python's `quote(s, safe)`.
 *
 * WHY not `encodeURIComponent`: JS leaves `!'()*` unescaped where Python
 * escapes them, which changes stored link bytes. Encoding UTF-8 bytes by
 * hand also keeps the hex case uppercase, as `quote` does.
 */
export function pyQuote(text: string, safe = ""): string {
  const allowed = new Set([...ALWAYS_SAFE, ...safe]);
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (const byte of bytes) {
    const character = String.fromCharCode(byte);
    if (allowed.has(character)) {
      out += character;
      continue;
    }
    out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/**
 * WHAT: encode a query map exactly like Python's `urlencode` with
 * `quote_via=quote, safe=""`.
 *
 * WHY pair order is preserved: Python dicts keep insertion order and so
 * does `Object.entries`, so a query built in a fixed order stays
 * byte-identical across the port. Values are stringified with `pyStr`
 * because Python calls `str()` on non-string values before quoting.
 */
export function pyUrlEncode(params: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    pairs.push(`${pyQuote(pyStr(key))}=${pyQuote(pyStr(value))}`);
  }
  return pairs.join("&");
}
