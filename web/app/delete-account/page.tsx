import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";
import { LegalDoc, List, P, Section } from "@/components/legal/LegalDoc";

export const metadata: Metadata = {
  title: "Delete your Chumbucket account",
  description: "How to delete your Chumbucket account in the app, or request deletion here.",
};

const FIELD: CSSProperties = {
  display: "block",
  width: "100%",
  boxSizing: "border-box",
  marginTop: 6,
  padding: "12px 14px",
  fontSize: 16,
  borderRadius: 12,
  border: "1px solid #D9C3C9",
  background: "#fff",
  color: "#1A1013",
};

const LABEL: CSSProperties = { display: "block", fontSize: 14, fontWeight: 600, color: "#1A1013", marginTop: 16 };

const STATUS: Record<string, { tone: "ok" | "error"; text: string }> = {
  sent: {
    tone: "ok",
    text: "Request received. We will confirm it is your account before deleting it, and reply to the contact you gave within 30 days.",
  },
  contact: { tone: "error", text: "Add an email address or X handle we can reach you on (3 to 254 characters)." },
  rate: { tone: "error", text: "We have received several requests recently, for this contact or overall. If you already sent one, we will be in touch and there is no need to send another; otherwise please try again in an hour." },
  unavailable: {
    tone: "error",
    text: "We couldn't send your request just now. Please try again in a few minutes, or delete your account in the app.",
  },
};

export default async function DeleteAccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const key = typeof params.status === "string" ? params.status : undefined;
  const status = key ? STATUS[key] : undefined;

  return (
    <LegalDoc
      title="Delete your account"
      intro={
        <P>
          You can delete your Chumbucket account at any time. The quickest way is in the app; if you can&rsquo;t get
          into the app any more, send us a request below.
        </P>
      }
    >
      <Section id="in-app" title="In the app">
        <List
          items={[
            "Open Chumbucket and go to Profile.",
            "Tap the settings icon, then Delete account.",
            "Read what will happen, type DELETE and confirm.",
          ]}
        />
        <P>This works however you sign in: a Solana wallet, Google or X. It takes effect immediately.</P>
      </Section>

      <Section id="what" title="What deletion removes and keeps">
        <List
          items={[
            "Removed: your name, @username, bio, picture, email, sign-ins, linked wallets, Google and X links, follows, friends, blocks, mutes, push tokens and inbox.",
            "Kept, anonymised: your calls stay in the public record as \"Deleted account\". A call is a permanent, timestamped statement that other people's records and receipts depend on.",
            "Kept for legal reasons: records of funded trades and your eligibility confirmations, linked only to the anonymised account.",
            "Not ours to delete: transactions on the Solana blockchain are public and permanent. Funds in your wallet stay in your wallet.",
          ]}
        />
        <P>
          Want a copy first? In the app, go to Profile, Settings, Privacy &amp; data, Export my data. See the{" "}
          <Link href="/privacy">Privacy Policy</Link> for details.
        </P>
      </Section>

      <Section id="request" title="Request deletion">
        {status && (
          <div
            role="status"
            style={{
              borderRadius: 12,
              padding: "12px 14px",
              margin: "0 0 12px",
              fontSize: 15,
              background: status.tone === "ok" ? "#E8F6EE" : "#FFE7EC",
              color: status.tone === "ok" ? "#14532D" : "#7A0F2A",
              border: `1px solid ${status.tone === "ok" ? "#86EFAC" : "#FFB0C0"}`,
            }}
          >
            {status.text}
          </div>
        )}
        <P>
          Tell us how to reach you and which account it is. We will ask you to prove the account is yours (for example
          by signing in, or signing a message with its wallet) before we delete anything.
        </P>
        <form method="post" action="/delete-account/request" style={{ marginTop: 8 }}>
          <label style={LABEL}>
            Email or X handle we can reply to
            <input name="contact" required minLength={3} maxLength={254} autoComplete="email" style={FIELD} />
          </label>
          <label style={LABEL}>
            Your Chumbucket @username (optional)
            <input name="handle" maxLength={40} autoComplete="off" style={FIELD} />
          </label>
          <label style={LABEL}>
            Wallet address you sign in with (optional)
            <input name="wallet" maxLength={64} autoComplete="off" spellCheck={false} style={FIELD} />
          </label>
          <label style={LABEL}>
            Anything else we should know (optional)
            <textarea name="details" maxLength={1000} rows={4} style={{ ...FIELD, resize: "vertical" }} />
          </label>
          {/* Left empty by people; bots fill it. */}
          <div aria-hidden="true" style={{ position: "absolute", left: -10000, width: 1, height: 1, overflow: "hidden" }}>
            <label>
              Leave this empty
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
          <button
            type="submit"
            style={{
              marginTop: 20,
              minHeight: 48,
              padding: "12px 22px",
              borderRadius: 999,
              border: 0,
              background: "#D81E4A",
              color: "#fff",
              fontSize: 16,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            Send deletion request
          </button>
        </form>
      </Section>
    </LegalDoc>
  );
}
