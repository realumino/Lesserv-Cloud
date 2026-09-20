/**
 * Display formatting for hashes, times, and expiries.
 *
 * WHY pure functions with an injectable clock: every page shows these
 * values, and "3m ago" is only testable when the clock is an argument
 * rather than a call to Date.now() buried in a component.
 */

/** Shorten a content hash for display; null becomes an em dash. */
export function shortHash(hash: string | null, length = 8): string {
  if (!hash) {
    return "—";
  }
  return hash.length > length ? `${hash.slice(0, length)}…` : hash;
}

/** Human-readable expiry: null = unset, 0 = never, otherwise a date. */
export function fmtExpire(expire: number | null): string {
  if (expire == null) {
    return "—";
  }
  if (expire === 0) {
    return "never";
  }
  return new Date(expire * 1000).toLocaleDateString();
}

/** Absolute local time for a Unix-seconds timestamp; null becomes an em dash. */
export function fmtTimestamp(timestamp: number | null): string {
  if (!timestamp) {
    return "—";
  }
  return new Date(timestamp * 1000).toLocaleString();
}

/** Unix seconds -> "YYYY-MM-DDTHH:MM" in local time for datetime-local inputs. */
export function toLocalInput(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

/** "YYYY-MM-DDTHH:MM" local input value -> Unix seconds. */
export function fromLocalInput(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

/** Coarse relative time ("12s ago") for liveness; null means "never". */
export function relativeTime(timestamp: number | null, now = Date.now()): string {
  if (!timestamp) {
    return "never";
  }
  const seconds = Math.floor(now / 1000) - timestamp;
  if (seconds < 60) {
    return seconds < 0 ? "just now" : `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}
