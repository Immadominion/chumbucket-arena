import { getPerson, recordLabel } from "@/lib/callsBff";
import { OG_SIZE, ogCard } from "@/lib/ogCard";

export const runtime = "nodejs";
export const revalidate = 300;
export const alt = "A caller on Chumbucket";
export const size = OG_SIZE;
export const contentType = "image/png";

type Params = { handle: string };

export default async function Image({ params }: { params: Promise<Params> | Params }) {
  const { handle } = await Promise.resolve(params);
  try {
    const { person, calls } = await getPerson(decodeURIComponent(handle));
    const latest = calls[0]?.market.question;
    return ogCard({
      eyebrow: "CALLER",
      lead: `${person.displayName} · @${person.handle}`,
      body: latest ? `Latest call: ${latest}` : "No public calls yet.",
      stamp:
        person.settledCalls > 0
          ? {
              text: `${person.correctCalls}/${person.settledCalls} RIGHT`,
              tone: person.correctCalls * 2 >= person.settledCalls ? "won" : "neutral",
            }
          : null,
      footer: recordLabel(person),
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
