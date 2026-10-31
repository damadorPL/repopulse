import { cn } from "@/lib/utils";

/** GitHub owner avatar with an initial-letter fallback. */
export function RepoAvatar({
  src,
  name,
  className,
}: {
  src: string | null | undefined;
  name: string;
  className?: string;
}) {
  const base = cn("size-9 shrink-0 rounded-md border bg-muted object-cover", className);
  if (!src) {
    return (
      <span aria-hidden className={cn(base, "flex items-center justify-center text-sm font-semibold uppercase text-muted-foreground")}>
        {name.charAt(0)}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element -- avatars.githubusercontent.com, already sized by GitHub
  return <img src={src.includes("?") ? src : `${src}?s=80`} alt="" className={base} loading="lazy" referrerPolicy="no-referrer" />;
}
