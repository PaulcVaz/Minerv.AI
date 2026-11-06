export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={`minerv-brand${compact ? " compact" : ""}`}
      aria-label="Minerv.AI"
    >
      <span className="brand-symbol" aria-hidden="true" />
      <span className="brand-word">
        Minerv<span className="brand-ai">.AI</span>
      </span>
    </span>
  );
}
