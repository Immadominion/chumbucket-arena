import { entryLabel, getCall, outcomeCopy, sideLabel, whenLabel } from "@/lib/callsBff";
import { OG_SIZE, ogCard } from "@/lib/ogCard";

export const runtime = "nodejs";
export const revalidate = 300;
export const alt = "A call on Chumbucket";
export const size = OG_SIZE;
export const contentType = "image/png";

type Params = { challengeId: string };

export default async function Image({ params }: { params: Promise<Params> | Params }) {
  const { challengeId } = await Promise.resolve(params);
  try {
    if (challengeId.startsWith("chg_")) throw new Error("legacy");
    const { entry } = await getCall(challengeId);
    const { call, author, market, result } = entry;
    const outcome = outcomeCopy(result);
    const price = entryLabel(call);
    return ogCard({
      eyebrow: "ON THE RECORD",
      lead: `${author.displayName} called`,
      pill: { text: sideLabel(market, call.side), side: call.side },
      trailing: price ? `at ${price}` : null,
      body: market.question,
      stamp:
        outcome.tone === "won"
          ? { text: "CORRECT", tone: "won" }
          : outcome.tone === "lost"
            ? { text: "INCORRECT", tone: "lost" }
            : outcome.tone === "void"
              ? { text: "VOID", tone: "neutral" }
              : { text: "PENDING", tone: "neutral" },
      footer: `Locked ${whenLabel(call.lockedAt) ?? ""} · on Panta`,
    });
  } catch {
    return ogCard({
      eyebrow: "CHUMBUCKET",
      lead: "See what people call",
      body: "Real prediction markets. Named people. Back them, fade them, keep the receipt.",
      footer: "Free calls · funded positions on Panta",
    });
  }
}
