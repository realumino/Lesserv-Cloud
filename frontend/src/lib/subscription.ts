/**
 * Subscription URL assembly for the admin UI.
 *
 * WHY a pure helper: the URL is a single canonical construction used by two
 * surfaces (the share dialog and the user edit page), and it must never
 * exist in two shapes. The origin is the browser's — the admin is already
 * viewing the plane at its public host, and the Vite dev proxy forwards
 * /sub to the local Worker, so the same code works in dev and production.
 */

/**
 * WHAT: build the subscription URL for one token, or null when absent.
 *
 * WHY null for a missing token: pre-M6 users have no token yet, and the
 * SubscriptionCard renders a Generate affordance for exactly that case —
 * a string like "…/sub/null" would be a trap.
 */
export function subscriptionUrl(
  origin: string,
  token: string | null,
): string | null {
  if (!token) {
    return null;
  }
  const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${base}/sub/${token}`;
}
