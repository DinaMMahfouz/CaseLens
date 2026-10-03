/** Text wordmark: the product name, no pictogram. */
export function Wordmark({ size = "md" }: { size?: "md" | "lg" }) {
  return (
    <span className={`font-semibold tracking-tight ${size === "lg" ? "text-xl" : "text-[15px]"}`}>
      Case<span className="text-muted font-medium">Lens</span>
    </span>
  );
}
