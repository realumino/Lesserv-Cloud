/**
 * A read-only, pretty-printed JSON pane.
 *
 * WHY the three-value convention (undefined = loading, null = empty,
 * otherwise content): every config pane on the node page has the same
 * lifecycle, and one component keeps the loading/empty distinction
 * identical across them.
 */
export default function JsonPanel({
  title,
  subtitle,
  value,
  empty,
}: {
  title: string;
  subtitle?: string;
  value: unknown;
  empty: string;
}) {
  return (
    <section className="rounded-2xl border border-apple-border bg-apple-card p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-apple-muted">
        {title}
        {subtitle && (
          <span className="ml-2 text-xs font-normal normal-case text-apple-muted/70">
            {subtitle}
          </span>
        )}
      </h2>
      {value === undefined ? (
        <p className="text-sm text-apple-muted">Loading…</p>
      ) : value === null ? (
        <p className="text-sm text-apple-muted">{empty}</p>
      ) : (
        <pre className="max-h-96 overflow-auto rounded-xl border border-apple-border bg-apple-bg p-3 text-xs text-apple-text">
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </section>
  );
}
