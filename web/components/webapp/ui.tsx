"use client";

/**
 * The web app's small parts: avatar, side pill, outcome badge, state screen,
 * skeletons, the wavy sheet and the segmented control. Each is the web cut of
 * the Android widget with the same job.
 */

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { avatarSrc } from "@/lib/callsBff";
import { callMark, initials, outcomeLabel } from "@/lib/webapp/format";
import { appPath, canGoBack, nextTrail } from "@/lib/webapp/paths";
import type { CallFeedEntry, CallOutcome, Side } from "@/lib/webapp/types";
import { Icon } from "./Icon";

/* eslint-disable @next/next/no-img-element */

export function Avatar({
  person,
  size = 42,
}: {
  person: { displayName: string; avatarUrl: string | null; avatarId?: number | null };
  size?: number;
}) {
  const src = avatarSrc(person);
  const [failed, setFailed] = useState(false);
  return (
    <span className="wa-avatar" style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }} aria-hidden>
      {src && !failed ? (
        <img src={src} alt="" width={size} height={size} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : (
        initials(person.displayName || "?")
      )}
    </span>
  );
}

export function SidePill({ side, label }: { side: Side; label?: string }) {
  const text = label && label.toUpperCase() !== side ? label : side;
  return <span className={`wa-side wa-side--${side}`}>{text}</span>;
}

const OUTCOME_ICON: Record<CallOutcome, string> = {
  CORRECT: "check-solid",
  INCORRECT: "cross",
  VOID: "cancel",
  PENDING: "clock",
};

export function OutcomeBadge({ outcome }: { outcome: CallOutcome }) {
  return (
    <span className={`wa-outcome wa-outcome--${outcome}`}>
      <Icon name={OUTCOME_ICON[outcome]} size={15} />
      {outcomeLabel(outcome)}
    </span>
  );
}

/** The one Free marker: a ghost chip, so it never reads as money. */
export function FreeChip() {
  return (
    <span className="wa-chip wa-chip--free" title="Free call">
      <Icon name="present" size={14} />
      <span className="wa-sr">Free call</span>
      <span aria-hidden>Free</span>
    </span>
  );
}

/** Money in, solid pink: "$5" once an amount is known, else "Funded". Only for a confirmed fill. */
export function FundedChip({ amount }: { amount?: string | null }) {
  return (
    <span className="wa-chip wa-chip--funded" title="Funded on Panta">
      <Icon name="wallet-solid" size={14} />
      {amount ?? "Funded"}
    </span>
  );
}

/**
 * Panta's attribution as a compact mark, not a sentence: the wordmark, beside
 * the trade it attributes (Panta's terms, §6). Never on calls, cards or lists.
 * No Panta logo ships in this repo, so the mark is text; beside "Trade" a
 * screen reader hears "Trade on Panta".
 */
export function PantaMark() {
  return (
    <span className="wa-pantamark">
      <span className="wa-sr">on Panta</span>
      <span aria-hidden>Panta</span>
    </span>
  );
}

/** Free, funded, or nothing for a state in between (see callMark). */
export function CallMarkChip({ entry }: { entry: Pick<CallFeedEntry, "call" | "funding"> }) {
  const mark = callMark(entry);
  return mark === "free" ? <FreeChip /> : mark === "funded" ? <FundedChip /> : null;
}

export type ArtName = "empty_calls" | "error" | "inbox" | "offline" | "people" | "record" | "search" | "success";

/**
 * A whole-screen (or whole-list) state: the app's Plankton and Karen art, one
 * short line, at most one action. The art is decorative; the line is the
 * accessible message.
 */
export function StateScreen({
  art,
  line,
  action,
  full = true,
  compact = false,
}: {
  art: ArtName;
  line: string;
  action?: { label: string; href?: string; onClick?: () => void };
  full?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`wa-state${full ? " wa-state--full" : ""}${compact ? " wa-state--compact" : ""}`} role="status">
      <img src={`/img/states/${art}.webp`} alt="" width={168} height={168} />
      <p>{line}</p>
      {action ? (
        action.href ? (
          <Link href={action.href} className="wa-btn wa-btn--soft">
            {action.label}
          </Link>
        ) : (
          <button type="button" className="wa-btn wa-btn--soft" onClick={action.onClick}>
            {action.label}
          </button>
        )
      ) : null}
    </div>
  );
}

/** Placeholder cards while a list loads for the first time (later visits open on the cache). */
export function SkeletonCards({ count = 3, tall = false }: { count?: number; tall?: boolean }) {
  return (
    <div className="wa-list" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="wa-card wa-call" style={{ minHeight: tall ? 190 : 150 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <div className="wa-skel" style={{ width: 42, height: 42, borderRadius: "50%" }} />
            <div style={{ flex: 1 }}>
              <div className="wa-skel" style={{ width: "40%", height: 12 }} />
              <div className="wa-skel" style={{ width: "25%", height: 10, marginTop: 8 }} />
            </div>
          </div>
          <div className="wa-skel" style={{ width: "88%", height: 16, marginTop: 16 }} />
          <div className="wa-skel" style={{ width: "62%", height: 16, marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  block = false,
}: {
  options: ReadonlyArray<{ id: T; label: string; icon?: string }>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  block?: boolean;
}) {
  return (
    <div className={`wa-seg${block ? " wa-seg--block" : ""}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)}>
          {o.icon ? <Icon name={o.icon} size={16} /> : null}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Where sheets render: inside the app root, so they share its styles. */
export function SheetPortal({ children }: { children: React.ReactNode }) {
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => setHost(document.getElementById("wa-portal")), []);
  return host ? createPortal(children, host) : null;
}

/**
 * ChumbucketWavySheet on the web: a floating card with the coral header and
 * its scalloped edge. No close button: it closes by dragging the header
 * down, tapping the handle or the backdrop, or Escape. A busy sheet refuses
 * all four.
 */
export function Sheet({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  busy = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  busy?: boolean;
}) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const [dy, setDy] = useState(0);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  useEffect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busyRef.current) onClose();
      if (e.key === "Tab" && panel.current) {
        const f = panel.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        );
        if (!f.length) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // Focus the first field or action, not the handle.
    requestAnimationFrame(() => {
      const target =
        panel.current?.querySelector<HTMLElement>("[data-autofocus]") ??
        panel.current?.querySelector<HTMLElement>(".wa-sheet-body input, .wa-sheet-body textarea, .wa-sheet-foot button") ??
        panel.current;
      target?.focus();
    });
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
      before?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { y: e.clientY, dy: 0 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    const raw = Math.max(0, e.clientY - drag.current.y);
    drag.current.dy = busy ? raw * 0.12 : raw;
    setDy(drag.current.dy);
  };
  const onPointerUp = () => {
    const moved = drag.current?.dy ?? 0;
    drag.current = null;
    const height = panel.current?.offsetHeight ?? 400;
    if (!busy && moved > height * 0.22) onClose();
    else setDy(0);
  };

  return (
    <SheetPortal>
      <div
        className="wa-sheet-backdrop"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !busy) onClose();
        }}
      >
        <div
          ref={panel}
          className="wa-sheet"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          style={dy ? { transform: `translateY(${dy}px)`, transition: drag.current ? "none" : "transform 240ms ease" } : undefined}
        >
          <div
            className="wa-sheet-head"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <button
              type="button"
              className="wa-sheet-handle"
              aria-label="Close"
              disabled={busy}
              onClick={onClose}
              onPointerDown={(e) => e.stopPropagation()}
            />
            <h2 id={titleId} className="wa-sheet-title">
              {title}
            </h2>
            {subtitle ? <p className="wa-sheet-sub">{subtitle}</p> : null}
          </div>
          <div className="wa-sheet-body">{children}</div>
          {footer ? <div className="wa-sheet-foot">{footer}</div> : null}
        </div>
      </div>
    </SheetPortal>
  );
}

/** Top of every screen: title, an optional back arrow, and up to a few icon actions. */
export function TopBar({
  title,
  back,
  children,
}: {
  /** Omitted on detail screens, whose own heading is the page's h1. */
  title?: string;
  back?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <header className="wa-topbar">
      {back ? <BackButton /> : null}
      {title ? <h1>{title}</h1> : <span style={{ flex: 1 }} />}
      {children ? <div className="wa-topbar-actions">{children}</div> : null}
    </header>
  );
}

/** The screens this visit has walked through in the app (the Shell keeps it; see `nextTrail`). */
let trail: string[] = [];

/** Follow the path, so Back knows whether there is a screen in the app to go back to. */
export function useTrail(path: string) {
  useEffect(() => {
    trail = nextTrail(trail, path);
  }, [path]);
}

function BackButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="wa-iconbtn"
      aria-label="Back"
      onClick={() => {
        // Back within the app only; a page opened straight from a link goes Home instead of leaving the site.
        if (canGoBack(trail)) window.history.back();
        else router.push(appPath.home);
      }}
    >
      <Icon name="arrow-left" size={22} />
    </button>
  );
}

/** Calls the callback once the element scrolls near the viewport (infinite lists). */
export function LoadMore({ onVisible, disabled }: { onVisible: () => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const cb = useRef(onVisible);
  cb.current = onVisible;
  useEffect(() => {
    if (disabled || !ref.current) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && cb.current(), {
      rootMargin: "600px 0px",
    });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [disabled]);
  return <div ref={ref} className="wa-more" aria-hidden />;
}

export function Spinner() {
  return <span className="wa-spinner" aria-hidden />;
}
