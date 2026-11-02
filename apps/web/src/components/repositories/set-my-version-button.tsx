"use client";

import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckIcon, PackageCheckIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { updateSubscriptionSettingsAction } from "@/server/actions/repositories";

/**
 * "Set as my version" in the reader (Slice 07): stores the release's tag as the version the user
 * runs, so newer releases get a "Newer than yours" marker and the repository shows how far behind it is.
 */
export function SetMyVersionButton({
  subscriptionId,
  fullName,
  tagName,
  isMyVersion,
}: {
  subscriptionId: string;
  fullName: string;
  tagName: string;
  isMyVersion: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [mine, setMine] = useOptimistic(isMyVersion);

  function set() {
    startTransition(async () => {
      setMine(true);
      const result = await updateSubscriptionSettingsAction({ subscriptionId, currentVersion: tagName });
      if (!result.ok) {
        if (result.error.code === "UNAUTHORIZED") router.push("/login");
        toast.error(result.error.message);
        return;
      }
      toast.success(`Your version of ${fullName} is ${tagName}`);
    });
  }

  if (mine) {
    return (
      <Button variant="outline" size="sm" disabled>
        <CheckIcon />
        Your version
      </Button>
    );
  }
  return (
    <Button variant="outline" size="sm" onClick={set} disabled={pending} title="Mark this as the version you run">
      <PackageCheckIcon />
      Set as my version
    </Button>
  );
}
