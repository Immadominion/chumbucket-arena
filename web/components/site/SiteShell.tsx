/**
 * The frame every public page shares: skip link, header, main, footer and
 * the floating "Get the Android app" button. Loads the site font, the
 * design tokens (site.css) and the motion layer (motion.css plus
 * MotionRoot, the one script every page runs for reveals, the header's
 * scrolled state and the hero's depth). Server component.
 */

import type { ReactNode } from "react";
import { GET_APP_HREF } from "./config";
import { DecorDefs } from "./decor/Decor";
import { machina } from "./fonts";
import { AndroidIcon } from "./icons";
import { MotionRoot } from "./motion/MotionRoot";
import { SiteFooter } from "./SiteFooter";
import { SiteHeader } from "./SiteHeader";
import "./site.css";
import "./motion/motion.css";

export function SiteShell({
  children,
  current,
  className,
}: {
  children: ReactNode;
  /** Highlights a header link ("home" on the landing page). */
  current?: "home";
  className?: string;
}) {
  return (
    <div className={`cb-site ${machina.variable}${className ? ` ${className}` : ""}`}>
      <a className="cb-skip" href="#main">
        Skip to content
      </a>
      <DecorDefs />
      <SiteHeader current={current} />
      <main id="main" className="cb-main">
        {children}
      </main>
      <SiteFooter />
      <a className="cb-fab" href={GET_APP_HREF} data-el="float.get-app">
        <AndroidIcon size={19} />
        Get the Android app
      </a>
      <MotionRoot />
    </div>
  );
}
