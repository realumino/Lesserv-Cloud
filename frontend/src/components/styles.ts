/**
 * Shared Tailwind class strings.
 *
 * WHY a module instead of inlining at every call site: the palette and
 * control treatments are one decision, so a change (or the Tailwind v4
 * theme port) should touch one file rather than twenty.
 */

export const cardClass =
  "rounded-2xl border border-apple-border bg-apple-card shadow-sm";

export const inputClass =
  "rounded-xl border border-apple-border bg-apple-card px-3 py-2 text-sm " +
  "text-apple-text placeholder-apple-gray transition-all focus:border-apple-blue " +
  "focus:ring-2 focus:ring-apple-blue/10 focus:outline-none";

export const primaryButton =
  "rounded-full bg-apple-blue px-5 py-2 text-sm font-medium text-white " +
  "shadow-sm transition-colors hover:bg-apple-blue-hover disabled:opacity-50";

export const secondaryButton =
  "rounded-full bg-apple-gray-surface px-4 py-2 text-sm font-medium " +
  "text-apple-text transition-colors hover:bg-apple-border disabled:opacity-50";

export const dangerButton =
  "rounded-full bg-apple-red/90 px-4 py-2 text-sm font-medium text-white " +
  "shadow-sm transition-colors hover:bg-apple-red disabled:opacity-50";
