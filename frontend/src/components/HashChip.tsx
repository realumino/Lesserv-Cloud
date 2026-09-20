/**
 * A monospace, shortened content hash with the full value on hover.
 *
 * WHY shorten: hashes are 64 hex characters and unreadable in a table; the
 * first 8 are enough to compare at a glance and the title carries the rest.
 */
import { shortHash } from "../lib/format";

export default function HashChip({ hash }: { hash: string | null }) {
  return (
    <code
      className="rounded-lg bg-apple-gray-surface px-2 py-1 font-mono text-xs text-apple-text"
      title={hash ?? undefined}
    >
      {shortHash(hash)}
    </code>
  );
}
