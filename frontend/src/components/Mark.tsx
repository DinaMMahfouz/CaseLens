export function Mark() {
  // A lens over a check mark.
  return (
    <svg viewBox="0 0 32 32" className="h-7 w-7" aria-hidden>
      <rect width="32" height="32" rx="7" fill="var(--color-elevated)" stroke="var(--color-line)" />
      <circle cx="14" cy="14" r="7.5" fill="none" stroke="var(--color-text)" strokeWidth="2.2" />
      <path d="M19.5 19.5l5.5 5.5" stroke="var(--color-text)" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M10.6 14.2l2.4 2.4 4.4-5" stroke="var(--color-accent)" strokeWidth="2.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
