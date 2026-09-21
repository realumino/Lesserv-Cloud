/**
 * Python-compatible JSON serialization and value formatting.
 *
 * WHY this module exists: `config_hash` is the SHA-256 of Python's
 * `json.dumps(runtime, sort_keys=True, separators=(",", ":"))`, and that
 * hash is the agent's sync contract. JS `JSON.stringify` diverges from
 * CPython on three observable points — non-ASCII escaping, key order for
 * astral characters, and float formatting — so the hash must be built by
 * code that reproduces CPython byte-for-byte instead of `JSON.stringify`.
 *
 * Known limit: after `JSON.parse`, a whole-number float literal (`100.0`)
 * is indistinguishable from an integer, so TS hashes it as `100`. That
 * divergence class (whole-number floats, oversized integers) is closed
 * operationally by the pre-cutover hash audit against production D1; the
 * fixtures pin the exact behavior so it never drifts silently.
 */

/**
 * WHAT: one JSON-shaped value as `JSON.parse` produces it.
 *
 * WHY a local alias and not `unknown`: canonical serialization walks
 * arbitrary config data, and this type keeps the recursive shape readable
 * without pulling in a schema library for data that is already parsed.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * WHAT: render one number the way Python `repr(float)` does.
 *
 * WHY: `json.dumps` writes floats via `repr`, so parity needs Python's
 * format selection, not JS `String()`: shortest round-trip digits, a fixed
 * form for decimal exponents -4..15 (always keeping a `.0`), and scientific
 * form outside that range with a signed, two-digit exponent (`1e-05`).
 */
export function pyFloatRepr(value: number): string {
  if (Number.isNaN(value)) {
    return "NaN";
  }
  if (value === Infinity) {
    return "Infinity";
  }
  if (value === -Infinity) {
    return "-Infinity";
  }
  if (Object.is(value, -0)) {
    return "-0.0";
  }
  if (value === 0) {
    return "0.0";
  }
  const negative = value < 0;
  const [mantissa, exponentText] = Math.abs(value).toExponential().split("e");
  const exponent = Number(exponentText);
  const digits = mantissa.replace(".", "");
  const body =
    exponent >= 16 || exponent <= -5
      ? formatExponential(digits, exponent)
      : formatFixed(digits, exponent);
  return negative ? `-${body}` : body;
}

/**
 * WHAT: render one non-negative float in Python's fixed-point form.
 *
 * WHY: `toExponential()` gives the shortest significant digits but never
 * the fixed layout Python uses for mid-range exponents, so the decimal
 * point is placed by hand and a trailing `.0` is kept for whole values.
 */
function formatFixed(digits: string, exponent: number): string {
  const point = exponent + 1;
  if (point <= 0) {
    return `0.${"0".repeat(-point)}${digits}`;
  }
  if (point >= digits.length) {
    return `${digits}${"0".repeat(point - digits.length)}.0`;
  }
  return `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * WHAT: render one non-negative float in Python's scientific form.
 *
 * WHY: Python always signs the exponent and pads it to at least two
 * digits (`1e-05`, `1e+21`); JS `toExponential` does neither, so the
 * exponent is rebuilt from the shortest digits.
 */
function formatExponential(digits: string, exponent: number): string {
  const sign = exponent < 0 ? "-" : "+";
  const magnitude = Math.abs(exponent).toString().padStart(2, "0");
  const mantissa = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${mantissa}e${sign}${magnitude}`;
}

/**
 * WHAT: render one string literal the way Python's `ensure_ascii=True` does.
 *
 * WHY: CPython escapes every non-ASCII code unit as `\uXXXX` (lowercase
 * hex), including each half of a surrogate pair, and uses short escapes for
 * the common control characters. Iterating UTF-16 code units reproduces
 * that exactly, lone surrogates included.
 */
export function pyStringLiteral(text: string): string {
  let out = '"';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    switch (code) {
      case 0x22:
        out += '\\"';
        continue;
      case 0x5c:
        out += "\\\\";
        continue;
      case 0x08:
        out += "\\b";
        continue;
      case 0x0c:
        out += "\\f";
        continue;
      case 0x0a:
        out += "\\n";
        continue;
      case 0x0d:
        out += "\\r";
        continue;
      case 0x09:
        out += "\\t";
        continue;
      default:
        break;
    }
    if (code < 0x20 || code === 0x7f || code >= 0x80) {
      out += `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += text[index];
  }
  return `${out}"`;
}

/**
 * WHAT: compare two strings by Unicode code point.
 *
 * WHY: Python sorts string keys by code point, JS `Array.prototype.sort`
 * by UTF-16 code unit; they disagree whenever an astral character and a
 * high BMP character share a prefix (U+FFFD before U+1F600 in Python,
 * after it in JS). `sort_keys=True` parity depends on this comparator.
 */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const shared = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < shared; index++) {
    const difference =
      (leftPoints[index].codePointAt(0) as number) -
      (rightPoints[index].codePointAt(0) as number);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftPoints.length - rightPoints.length;
}

/**
 * WHAT: serialize one value exactly like Python's canonical `json.dumps`.
 *
 * WHY: this is the function `config_hash` calls; the separators, sorted
 * keys, and `ensure_ascii` escaping above are the whole point. Integers are
 * emitted as decimal integers and floats through `pyFloatRepr`, matching
 * CPython's own type split.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) {
      return "-0.0";
    }
    return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  }
  if (typeof value === "string") {
    return pyStringLiteral(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort(compareCodePoints)
      .map((key) => `${pyStringLiteral(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
}

/**
 * WHAT: render one string the way Python's `repr()` does.
 *
 * WHY: warning text uses `%r` in the copied allocator
 * (`missing uuid for 'alice@OUTBOUND'`), and repr picks its quote character
 * from the content. Only strings reach this helper; the port never reprs
 * other shapes.
 */
export function pyReprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const character of text) {
    if (character === "\\") {
      out += "\\\\";
      continue;
    }
    if (character === quote) {
      out += `\\${quote}`;
      continue;
    }
    if (character === "\n") {
      out += "\\n";
      continue;
    }
    if (character === "\r") {
      out += "\\r";
      continue;
    }
    if (character === "\t") {
      out += "\\t";
      continue;
    }
    const code = character.codePointAt(0) as number;
    out += code < 0x20 || code === 0x7f
      ? `\\x${code.toString(16).padStart(2, "0")}`
      : character;
  }
  return `${out}${quote}`;
}

/**
 * WHAT: format one value the way Python's `str()` does.
 *
 * WHY: `urlencode` stringifies non-string query values (`True`, `None`,
 * `443`) and warning text interpolates config values that may be missing.
 * The few shapes that reach those call sites are covered here; containers
 * fall back to JS text because Python's container repr is never observable
 * in the frozen surfaces.
 */
export function pyStr(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "None";
  }
  if (typeof value === "boolean") {
    return value ? "True" : "False";
  }
  if (typeof value === "number") {
    if (Object.is(value, -0)) {
      return "-0.0";
    }
    return Number.isInteger(value) ? String(value) : pyFloatRepr(value);
  }
  return String(value);
}
