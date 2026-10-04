"use client";

/** The one full-screen state a screen shows when it has nothing to show. */

import { BffOffline, BffRejected } from "@/lib/webapp/bff";
import { appPath } from "@/lib/webapp/paths";
import { StateScreen } from "../ui";

export function screenError(error: unknown, retry: () => void, notFound = "This isn’t here") {
  if (error instanceof BffOffline) {
    return <StateScreen art="offline" line="You’re offline" action={{ label: "Try again", onClick: retry }} />;
  }
  if (error instanceof BffRejected && error.code === "NOT_FOUND") {
    return <StateScreen art="search" line={notFound} action={{ label: "Go home", href: appPath.home }} />;
  }
  return <StateScreen art="error" line="Couldn’t load this" action={{ label: "Try again", onClick: retry }} />;
}
