/**
 * A red note for one error message.
 *
 * WHY a component: every page has the same failure shape, and a single
 * place keeps error styling consistent with the archived panel.
 */
export default function ErrorNote({ children }: { children: string }) {
  return (
    <p className="rounded-xl border border-[#ff453a]/20 bg-[#ffecea] px-4 py-2.5 text-sm font-medium text-apple-red">
      {children}
    </p>
  );
}
