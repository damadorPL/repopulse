import { appReleaseUrl } from "@/lib/app-version";
import { cn } from "@/lib/utils";

/** Links the displayed RepoPulse version to its corresponding GitHub release page. */
export function AppVersionLink({ className, title }: { className?: string; title?: string }) {
  const version = process.env.APP_VERSION;
  return (
    <p className={cn("text-muted-foreground tabular-nums", className)} title={title}>
      <a
        href={appReleaseUrl(version)}
        target="_blank"
        rel="noopener noreferrer"
        className="transition-colors hover:text-foreground hover:underline"
      >
        {version ? `RepoPulse v${version}` : "RepoPulse"}
      </a>
    </p>
  );
}
