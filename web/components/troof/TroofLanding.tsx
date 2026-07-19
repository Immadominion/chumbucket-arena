"use client";

/**
 * Troof Figma host — Chumbucket theme.
 * Fixes: stage height (no scroll past footer), phone radius, mobile layout.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import AppLandingPage from "./AppLandingPage";

const DESIGN_WIDTH = 1440;
const DESIGN_HEIGHT = 5887;
const MOBILE_BP = 768;

export default function TroofLanding() {
  const stageRef = useRef<HTMLDivElement>(null);
  const scalerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const phonesDone = useRef(false);
  const headingsDone = useRef(false);
  const blobsDone = useRef(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${MOBILE_BP - 1}px)`);
    const applyMq = () => setIsMobile(mq.matches);
    applyMq();
    mq.addEventListener("change", applyMq);
    return () => mq.removeEventListener("change", applyMq);
  }, []);

  useEffect(() => {
    if (isMobile) return; // desktop Troof host only

    const fit = () => {
      const scaler = scalerRef.current;
      const stage = stageRef.current;
      if (!scaler || !stage) return;
      const vw = document.documentElement.clientWidth;
      const scale = Math.min(1, vw / DESIGN_WIDTH);
      scaler.style.transform = `scale(${scale})`;
      // Critical: transform does NOT shrink layout box. Stage must clip
      // the unscaled 5887px child or the page scrolls into empty space.
      const frame = rootRef.current?.firstElementChild as HTMLElement | null;
      const rawH = frame?.offsetHeight || DESIGN_HEIGHT;
      stage.style.height = `${rawH * scale}px`;
      stage.style.overflow = "hidden";
    };

    const fixPhones = () => {
      if (phonesDone.current) return;
      const devices = document.querySelectorAll(".fig-asset-923e4e99f7ec5c1b");
      if (!devices.length) return;
      let fixed = 0;
      devices.forEach((dev) => {
        const shell = dev.parentElement as HTMLElement | null;
        if (!shell) return;
        shell.classList.add("troof-phone-shell");
        shell.style.borderRadius = "42px";
        shell.style.overflow = "hidden";
        (dev as HTMLElement).style.borderRadius = "42px";

        const kids = Array.from(shell.children) as HTMLElement[];
        kids.forEach((kid) => {
          if (kid === dev) return;
          if (kid.tagName.toLowerCase() === "svg") {
            kid.style.display = "none";
            return;
          }
          kid.querySelectorAll("svg").forEach((s) => {
            (s as SVGElement).style.display = "none";
          });
          kid.classList.add("troof-phone-screen");
          kid.style.borderRadius = "34px";
          kid.style.overflow = "hidden";
          kid.querySelectorAll("div").forEach((d) => {
            const el = d as HTMLElement;
            if (el.style.overflow === "hidden") {
              el.style.borderRadius = "32px";
            }
          });
        });
        fixed++;
      });
      if (fixed) phonesDone.current = true;
    };

    const fixHeadings = () => {
      if (headingsDone.current) return;
      let fixed = 0;
      document.querySelectorAll("#troof-root div").forEach((w) => {
        const el = w as HTMLElement;
        if (el.style.overflow === "hidden" && el.style.height === "48px") {
          const span = el.querySelector(":scope > span") as HTMLElement | null;
          if (!span) return;
          el.style.overflow = "visible";
          el.style.height = "auto";
          span.style.whiteSpace = "nowrap";
          span.style.height = "auto";
          span.style.width = "auto";
          fixed++;
        }
      });
      // Unclip text spans that still overflow their Figma boxes
      document.querySelectorAll("#troof-root span").forEach((s) => {
        const el = s as HTMLElement;
        if (el.scrollHeight > el.clientHeight + 2 && el.style.overflow !== "visible") {
          el.style.overflow = "visible";
        }
      });
      if (fixed) headingsDone.current = true;
    };

    const softenBlobs = () => {
      if (blobsDone.current) return;
      let done = 0;
      const seen = new Set<Element>();
      document.querySelectorAll("#troof-root div").forEach((d) => {
        const el = d as HTMLElement;
        const bg = el.style.backgroundColor.replace(/\s+/g, "");
        const isBlob =
          bg === "rgb(255,176,192)" ||
          bg === "rgb(255,90,118)" ||
          bg === "rgb(253,229,152)" ||
          bg === "rgb(85,184,255)";
        if (el.style.borderRadius === "50%" && isBlob && parseFloat(el.style.width) > 120) {
          el.style.filter = "blur(60px)";
          const p = el.parentElement as HTMLElement | null;
          if (p && p.style.overflow === "hidden") {
            p.style.overflow = "visible";
            if (!seen.has(p)) {
              p.style.opacity = "0.7";
              seen.add(p);
            }
          }
          done++;
        }
      });
      if (done) blobsDone.current = true;
    };

    const refine = () => {
      fit();
      fixPhones();
      fixHeadings();
      softenBlobs();
    };

    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      const text = (t.textContent || "").trim().toLowerCase();
      if (
        text === "get started" ||
        text === "open arena" ||
        text === "join waitlist" ||
        text === "take tour"
      ) {
        e.preventDefault();
        e.stopPropagation();
        router.push("/contract");
      }
      if (text === "see proof" || text === "proof" || text === "live chat") {
        e.preventDefault();
        e.stopPropagation();
        router.push("/proof");
      }
    };
    document.addEventListener("click", onClick, true);

    requestAnimationFrame(() => {
      refine();
      requestAnimationFrame(refine);
    });
    window.addEventListener("resize", fit);
    const fontsReady = document.fonts?.ready?.then(() => {
      phonesDone.current = false;
      refine();
    });
    const timers = [200, 500, 1000, 1800, 3000].map((t) =>
      setTimeout(() => {
        phonesDone.current = false;
        refine();
      }, t),
    );

    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("resize", fit);
      timers.forEach(clearTimeout);
      void fontsReady;
    };
  }, [router, isMobile]);

  if (isMobile) {
    return <MobileLanding />;
  }

  return (
    <div ref={stageRef} id="troof-stage" className="troof-stage">
      <div ref={scalerRef} id="troof-scaler" className="troof-scaler">
        <div ref={rootRef} id="troof-root">
          <AppLandingPage />
        </div>
      </div>
    </div>
  );
}

/** Readable mobile layout — same product story, not a scaled 1440 artboard. */
function MobileLanding() {
  return (
    <div className="cb-m">
      <header className="cb-m-nav">
        <div className="cb-m-brand">
          <Image src="/img/bucket.png" alt="" width={32} height={32} style={{ objectFit: "contain" }} />
          <span>CHUMBUCKET</span>
        </div>
        <Link href="/contract" className="cb-m-nav-cta">
          Open
        </Link>
      </header>

      <section className="cb-m-hero">
        <p className="cb-m-kicker">football pots · with friends</p>
        <h1>
          Call the match
          <br />
          with <em>friends.</em>
        </h1>
        <p className="cb-m-lead">
          Pick a side. Lock a stake. When the final whistle goes, the winner gets paid.
        </p>
        <div className="cb-m-actions">
          <Link href="/contract" className="cb-m-btn">
            Get started
            <Arrow />
          </Link>
          <Link href="/proof" className="cb-m-btn-ghost">
            See a proof
          </Link>
        </div>
        <div className="cb-m-phones" aria-hidden>
          <div className="cb-m-phone">
            <Image src="/product-shots/home.png" alt="" fill sizes="42vw" priority />
          </div>
          <div className="cb-m-phone cb-m-phone-b">
            <Image src="/product-shots/calls.png" alt="" fill sizes="42vw" priority />
          </div>
        </div>
      </section>

      <section className="cb-m-section">
        <p className="cb-m-kicker">what you can do</p>
        <h2>Three simple moves</h2>
        <Feature
          title="Call a fixture"
          body="Today's matches are listed. Choose home, draw, or away and put USDC in the pot."
        />
        <Feature
          title="Challenge a mate"
          body="Send a link. You both lock a stake. Winner claims when the match is over."
        />
        <Feature
          title="Follow people who call well"
          body="See what your friends are on. Copy a call into the same pot, or start your own."
        />
      </section>

      <section className="cb-m-section cb-m-alt">
        <p className="cb-m-kicker">why it works</p>
        <h2>Money stays put until full time</h2>
        <Feature
          title="Locked until the whistle"
          body="Your stake sits in the pot for that match. We can't move it mid-game."
        />
        <Feature
          title="The score settles it"
          body="Nobody at Chumbucket types in the result. The pot only opens after the real final score checks out."
        />
        <Feature
          title="Phone and web"
          body="Same account on the app and this site — friends, pots, and balance carry over."
        />
      </section>

      <section className="cb-m-cta">
        <h2>Ready to call a match?</h2>
        <p>Open the Arena, pick a fixture, and put something on it with a mate.</p>
        <Link href="/contract" className="cb-m-btn">
          Open Arena
          <Arrow />
        </Link>
      </section>

      <footer className="cb-m-footer">
        <div className="cb-m-brand">
          <Image src="/img/bucket.png" alt="" width={24} height={24} style={{ objectFit: "contain" }} />
          <span>CHUMBUCKET</span>
        </div>
        <p>Football pots with friends</p>
      </footer>
    </div>
  );
}

function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="cb-m-card">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

function Arrow() {
  return (
    <svg width="18" height="12" viewBox="0 0 18 12" fill="none" aria-hidden>
      <path d="M0 6h14" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 1l5 5-5 5" stroke="currentColor" strokeWidth="1.6" fill="none" />
    </svg>
  );
}
