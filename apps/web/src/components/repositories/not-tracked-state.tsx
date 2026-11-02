"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeftIcon, BoxesIcon, PlusIcon } from "lucide-react";
import { AddRepoModal } from "@/components/modals/add-repo-modal";
import { Button } from "@/components/ui/button";
import type { TagPill } from "@/server/queries/feed";

function segment(value: string | string[] | undefined): string {
  const raw = Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** "You don't track owner/name" with an Add button prefilled with the slug (Slice 07). */
export function NotTrackedState({ tags }: { tags: TagPill[] }) {
  const params = useParams<{ owner: string; name: string }>();
  const owner = segment(params.owner);
  const name = segment(params.name);
  const slug = owner && name ? `${owner}/${name}` : "";

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link href="/repositories" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-4" aria-hidden />
        Tracked repositories
      </Link>
      <div className="flex flex-col items-center rounded-lg border border-dashed px-6 py-14 text-center">
        <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <BoxesIcon className="size-5" />
        </span>
        <h1 className="mt-4 font-medium">
          You don&apos;t track {slug ? <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">{slug}</code> : "this repository"}
        </h1>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          Add it to see its releases in your feed and change its settings here.
        </p>
        <div className="mt-5">
          <AddRepoModal tags={tags} defaultRepo={slug}>
            <Button>
              <PlusIcon />
              Add repository
            </Button>
          </AddRepoModal>
        </div>
      </div>
    </div>
  );
}
