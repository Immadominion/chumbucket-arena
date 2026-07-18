"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** The Gaffer's old hub. ChumBucket's home is the Arena — bounce any lingering link. */
export default function TouchlineRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/arena");
  }, [router]);
  return null;
}
