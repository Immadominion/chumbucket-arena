/**
 * chumbucket.fun: the landing page.
 *
 * Hand-written replacement for the Figma export that used to render the
 * live page (components/troof/AppLandingPage.jsx). Same design, real
 * layout: one component per section under components/site/landing, shared
 * tokens in components/site/site.css. docs/website-structure.md maps every
 * visual element to its component and animation hook.
 *
 * Server-rendered and revalidated every minute: the social-proof section
 * shows a real public call from the calls feed, or says plainly that there
 * is none (or that the feed is down). Nothing on the page is invented.
 */

import type { Metadata } from "next";
// The shell (and with it site.css) first, so landing.css cascades after it.
import { SiteShell } from "@/components/site/SiteShell";
import { Benefits } from "@/components/site/landing/Benefits";
import { Faq } from "@/components/site/landing/Faq";
import { Features } from "@/components/site/landing/Features";
import { GetTheApp } from "@/components/site/landing/GetTheApp";
import { Hero } from "@/components/site/landing/Hero";
import { SocialProof } from "@/components/site/landing/SocialProof";
import "@/components/site/landing/landing.css";
import { getFeed, maybe } from "@/lib/callsBff";
import { heroProofLink, proofState } from "@/lib/landingProof";

export const revalidate = 60;

const TITLE = "Chumbucket: see what people call on real prediction markets";
const DESCRIPTION =
  "Follow named people's calls on live Panta prediction markets. Back them, fade them, or make your own call, and keep the receipt when the market settles.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: { title: TITLE, description: DESCRIPTION, url: "/", images: ["/img/logo-320.png"] },
  twitter: { card: "summary", title: TITLE, description: DESCRIPTION },
};

export default async function HomePage() {
  const state = proofState(await maybe(getFeed(12)));
  return (
    <SiteShell current="home" className="cb-landing">
      <Hero proofLink={heroProofLink(state)} />
      <Features />
      <Benefits />
      <SocialProof state={state} />
      <Faq />
      <GetTheApp />
    </SiteShell>
  );
}
