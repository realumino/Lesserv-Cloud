/**
 * Readable display names for tags, nodes, profiles, and generated links.
 *
 * WHY this exists: qualified machine names (`reality-tokyo01`) are
 * unambiguous but unfriendly. Display names combine stored labels for nodes
 * and profiles with prettified local tags, so an admin and an end user see
 * readable text without ever storing display state that can rot when a
 * config changes.
 */

const ACRONYMS = new Set([
  "grpc",
  "http",
  "httpupgrade",
  "in",
  "reality",
  "tls",
  "trojan",
  "vless",
  "vmess",
  "ws",
  "xhttp",
]);

/**
 * WHAT: return one tag word in display case, preserving known acronyms.
 *
 * WHY: transport and security names are read as acronyms (`XHTTP`, not
 * `Xhttp`), while ordinary words get sentence case.
 */
function displayWord(word: string): string {
  if (!word) {
    return "";
  }
  const lowered = word.toLowerCase();
  if (ACRONYMS.has(lowered)) {
    return lowered.toUpperCase();
  }
  return word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * WHAT: return a readable display name for one local tag.
 *
 * WHY separators are normalized: local tags use hyphens or underscores as
 * word separators. Display names use spaces, title casing, and uppercase
 * transport/security acronyms (`xhttp` becomes `XHTTP`, `niigata` becomes
 * `Niigata`). Non-strings have no display name rather than a guess.
 */
export function prettyTag(tag: unknown): string {
  if (typeof tag !== "string") {
    return "";
  }
  const words = tag
    .trim()
    .split(/[-_]+/)
    .filter((word) => word);
  return words.map(displayWord).join(" ");
}

/**
 * WHAT: return the readable label for one generated link.
 *
 * WHY this order: the node is the fleet context, the subject is either the
 * prettified inbound or a stored profile label, and the exit is last. The
 * result is cosmetic only; routing and accounting use qualified names.
 */
export function linkLabel(
  nodeLabel: string,
  subjectLabel: string,
  outboundLabel: string,
): string {
  return `${nodeLabel} · ${subjectLabel} → ${outboundLabel}`;
}
