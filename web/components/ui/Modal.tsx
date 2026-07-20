"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function Modal({
  open,
  onClose,
  children,
  width = 440,
  dark = false,
  label,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width?: number;
  dark?: boolean;
  /** Accessible name for the dialog (announced on open). Falls back to "Dialog". */
  label?: string;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  // Callers pass a fresh onClose each render; keep it in a ref so the focus
  // effect can depend on `open` alone and never re-run (which would yank focus
  // out of an input mid-keystroke on an unrelated parent re-render).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    // Remember what had focus (the trigger) so we can hand it back on close.
    restoreRef.current = document.activeElement as HTMLElement | null;

    const dialog = dialogRef.current;
    // Move focus into the dialog, unless a child already claimed it (autoFocus).
    if (dialog && !dialog.contains(document.activeElement)) {
      const first = dialog.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? dialog).focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      // Trap Tab / Shift+Tab inside the dialog.
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (nodes.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey) {
        if (active === first || !dialog.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialog.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      // Hand focus back to the trigger, if it's still on the page.
      const el = restoreRef.current;
      if (el && document.contains(el)) el.focus();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 90,
        background: "rgba(8,16,12,.55)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        animation: "fadein .15s ease",
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? "Dialog"}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width,
          maxWidth: "100%",
          background: dark ? "#1a1013" : "#fff",
          color: dark ? "#fff" : "#221217",
          borderRadius: 24,
          boxShadow: "0 40px 100px rgba(8,16,12,.45)",
          overflow: "hidden",
          outline: "none",
          animation: "popin .18s cubic-bezier(.2,.8,.2,1)",
        }}
      >
        {children}
      </div>
    </div>
  );
}
