"use client";

import type { ComponentProps, ReactNode } from "react";
import Image from "next/image";
import { cn } from "@/lib/utils";

export function HandsStage({
  children,
  contentClassName,
  ...props
}: {
  children: ReactNode;
  contentClassName?: string;
} & ComponentProps<"main">) {
  return (
    <main
      {...props}
      className={cn(
        "relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-6 py-12 text-foreground",
        props.className,
      )}
    >
      <Image
        src="/hand-left.png"
        alt=""
        width={260}
        height={260}
        className="pointer-events-none absolute left-0 top-1/2 hidden -translate-x-1/4 -translate-y-1/2 object-contain opacity-80 lg:block"
        priority
      />
      <Image
        src="/hand-right.png"
        alt=""
        width={260}
        height={260}
        className="pointer-events-none absolute right-0 top-1/2 hidden translate-x-1/4 -translate-y-1/2 object-contain opacity-80 lg:block"
        priority
      />
      <section className={cn("relative z-10 w-full max-w-xl", contentClassName)}>{children}</section>
    </main>
  );
}
