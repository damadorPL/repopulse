"use client";

import type { ComponentProps, ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { LoaderCircleIcon } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Submit button that reflects its enclosing `<form>`'s pending state via `useFormStatus`. */
export function SubmitButton({
  children,
  pendingLabel,
  idleIcon,
  disabled,
  ...props
}: Omit<ComponentProps<typeof Button>, "type"> & {
  pendingLabel?: string;
  idleIcon?: ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={disabled || pending} aria-busy={pending || undefined} {...props}>
      {pending ? <LoaderCircleIcon className="animate-spin" aria-hidden /> : idleIcon}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
