import { getMarket, percentLabel, sideLabel, statusCopy, whenLabel } from "@/lib/callsBff";
import { OG_SIZE, ogCard } from "@/lib/ogCard";

export const runtime = "nodejs";
export const revalidate = 300;
export const alt = "A prediction market on Chumbucket";
export const size = OG_SIZE;
export const contentType = "image/png";

type Params = { marketId: string };

export default async function Image({ params }: { params: Promise<Params> | Params }) {
  const { marketId } = await Promise.resolve(params);
  try {
    const { market, sharePrice } = await getMarket(decodeURIComponent(marketId));
    const yes = percentLabel(sharePrice?.yesPrice);
    const no = percentLabel(sharePrice?.noPrice);
    const prices =
      yes || no
        ? `${sideLabel(market, "YES")} ${yes ?? "–"} · ${sideLabel(market, "NO")} ${no ?? "–"}`
        : statusCopy(market.status);
    const closes = whenLabel(market.closesAt);
    return ogCard({
      eyebrow: "WHAT'S YOUR CALL?",
      lead: prices,
      body: market.question,
      stamp: { text: statusCopy(market.status).toUpperCase(), tone: "neutral" },
      footer: closes ? `${market.status === "OPEN" ? "Closes" : "Closed"} ${closes} · on Panta` : "On Panta",
    });
  } catch {
    return ogCard({
      eyebrow: "CHUMBUCKET",
      lead: "What's your call?",
      body: "Real prediction markets. Named people. Back them, fade them, keep the receipt.",
      footer: "Free calls · funded positions on Panta",
    });
  }
}
