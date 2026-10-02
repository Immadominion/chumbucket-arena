import type { Metadata } from "next";
import Link from "next/link";
import { Ext, LegalDoc, List, P, Section } from "@/components/legal/LegalDoc";

export const metadata: Metadata = {
  title: "Privacy Policy (draft) · Chumbucket",
  description: "What Chumbucket collects, who it goes to, and how to export or delete it.",
  robots: { index: false },
};

const toc = [
  { id: "collect", label: "What we collect" },
  { id: "public", label: "What other people can see" },
  { id: "use", label: "How we use it" },
  { id: "share", label: "Who receives it" },
  { id: "analytics", label: "Analytics and notifications" },
  { id: "retention", label: "How long we keep it" },
  { id: "rights", label: "Your choices and rights" },
  { id: "other", label: "Children, transfers, security, changes" },
];

export default function PrivacyPage() {
  return (
    <LegalDoc
      title="Privacy Policy"
      toc={toc}
      intro={
        <P>
          This policy explains what the Chumbucket app and website collect, why, who receives it, and how you can
          export or delete it. Chumbucket is operated by [Operator legal name], [registered address], which is the
          controller of your personal data. Contact: [privacy contact email].
        </P>
      }
    >
      <Section id="collect" title="1. What we collect">
        <List
          items={[
            <>
              <strong>Account:</strong> your display name, @username, bio and chosen picture, and when you joined.
            </>,
            <>
              <strong>Sign-in:</strong> if you use Google, your Google account id, email address and name; if you use
              X, your X account id and username; if you use a Solana wallet, its public address and the signed message
              that proves you control it. We never receive your passwords or wallet keys.
            </>,
            <>
              <strong>What you do on Chumbucket:</strong> your calls and theses, Back, Fade and Dare responses, who you
              follow, reports you file, and who you block or mute.
            </>,
            <>
              <strong>Funded trades:</strong> for each order, the call it belongs to, the wallet address, market, side,
              amount, order status and Solana transaction signature.
            </>,
            <>
              <strong>Eligibility confirmations:</strong> that you confirmed you are 18 or older, eligible where you
              live and accept Panta&rsquo;s terms, with the terms version and time.
            </>,
            <>
              <strong>Device:</strong> a push notification token and whether your device is Android or iOS, so we can
              send notifications you have allowed.
            </>,
            <>
              <strong>Support:</strong> what you write to us in the support chat.
            </>,
            <>
              <strong>Technical logs:</strong> our servers record requests (including IP address, time and the action
              requested) for security and to fix problems.
            </>,
          ]}
        />
        <P>We do not collect your contacts, precise location, photos or card details.</P>
      </Section>

      <Section id="public" title="2. What other people can see">
        <P>
          Chumbucket is a public network. Your display name, @username, picture, calls and theses, your responses,
          your record and accuracy, and receipts you or others share are visible to anyone, including people who are
          not signed in. Calls marked &ldquo;followers only&rdquo; are visible to your followers. Your linked wallet
          address can be visible alongside your profile, and everything you do on the Solana blockchain (including
          funded trades) is public there and permanent.
        </P>
      </Section>

      <Section id="use" title="3. How we use it">
        <List
          items={[
            "to run your account, show your calls and record, and settle receipts from venue results (performing our contract with you);",
            "to prepare funded trades you ask for and show their status (contract);",
            "to keep Chumbucket safe: rate limits, the link and language filter, reports, blocks and fraud prevention (legitimate interests and legal obligations);",
            "to record your eligibility confirmation before funded trading (legal obligations and legitimate interests);",
            "to send notifications you have allowed (consent);",
            "to measure how the app is used, only if you switch analytics on (consent).",
          ]}
        />
        <P>We do not sell your personal data and we do not use it for advertising.</P>
      </Section>

      <Section id="share" title="4. Who receives it">
        <P>We share personal data only with the services that run Chumbucket, and only what each needs:</P>
        <List
          items={[
            <>
              <strong>Supabase</strong> &mdash; our database and sign-in service. Holds the data in section 1.
            </>,
            <>
              <strong>Railway</strong> &mdash; hosts our API servers, which process your requests and keep technical
              logs.
            </>,
            <>
              <strong>Vercel</strong> &mdash; hosts this website.
            </>,
            <>
              <strong>Google and X</strong> &mdash; if you sign in with them, they confirm who you are to us.
            </>,
            <>
              <strong>Panta Market</strong> (Balr Holdings Corporation) &mdash; provides market data and executes funded
              trades. For a trade, Panta receives your wallet address and the order. We do not send Panta your name,
              email or Chumbucket account id. <Ext href="https://panta.market">panta.market</Ext>
            </>,
            <>
              <strong>Crossmint</strong> &mdash; if you add funds by card or bank, Crossmint processes the payment and
              may verify your identity under its own privacy policy. It receives your wallet address.
            </>,
            <>
              <strong>Solana network and RPC providers</strong> (such as Helius) &mdash; read balances and send the
              transactions you sign. They see your wallet address and IP address.
            </>,
            <>
              <strong>Google Firebase Cloud Messaging</strong> &mdash; delivers push notifications using your device
              token.
            </>,
            <>
              <strong>Tawk.to</strong> &mdash; runs the support chat when you open it.
            </>,
            <>
              <strong>Shorebird</strong> &mdash; delivers app updates and receives your app version and basic device
              information.
            </>,
            <>
              <strong>Legacy website features</strong> &mdash; the older Arena pages of this website use Privy for
              sign-in and embedded wallets, may use Anthropic to generate replies in the &ldquo;Gaffer&rdquo; chat, and
              mirror Arena money events to the public Walrus network.
            </>,
          ]}
        />
        <P>
          We may also disclose data when the law requires it, to protect people&rsquo;s safety, or as part of a merger or
          sale, in which case this policy continues to apply.
        </P>
        <P>
          Earlier versions of the app sent your wallet address and display name to a private Telegram channel we used
          for internal alerts when you signed in or created an escrow challenge. Current versions do not.
        </P>
      </Section>

      <Section id="analytics" title="5. Analytics and notifications">
        <P>
          Product analytics are off until you switch them on in the app (Profile, Settings, Privacy). When on, usage
          events are recorded without your name, wallet or thesis text. Today they stay on your device: we have not
          chosen an analytics provider. If we add one, we will name it here and ask again before anything is sent. You
          can switch analytics off at any time.
        </P>
        <P>
          Push notifications are sent only if you allow them in your device settings. We do not use crash reporting
          services at this time.
        </P>
      </Section>

      <Section id="retention" title="6. How long we keep it">
        <List
          items={[
            "Your account data is kept until you delete your account.",
            "When you delete your account we remove your name, @username, bio, picture, email, sign-ins, linked wallets, Google or X links, follows, friends, blocks, mutes, push tokens and inbox. Your calls stay in the public record as \"Deleted account\", because a call is a permanent, timestamped statement other people's records and receipts depend on.",
            "Records of funded trades and your eligibility confirmations are kept for [retention period] to meet legal and financial obligations, linked only to the anonymised account.",
            "A security log of wallet links and removals is kept for [retention period].",
            "Database backups are overwritten within [backup window].",
            "Anything written to a public blockchain stays there permanently; no one can delete it.",
          ]}
        />
      </Section>

      <Section id="rights" title="7. Your choices and rights">
        <List
          items={[
            <>
              <strong>Export:</strong> in the app, Profile, Settings, Export my data gives you a copy of your profile,
              calls, responses, follows, blocks, mutes, reports and trade records in JSON.
            </>,
            <>
              <strong>Delete:</strong> in the app, Profile, Settings, Delete account; or{" "}
              <Link href="/delete-account">request deletion on the web</Link>.
            </>,
            <>
              <strong>Correct:</strong> edit your name, bio and picture in your profile.
            </>,
            <>
              <strong>Withdraw consent:</strong> switch analytics or notifications off at any time.
            </>,
            <>
              Depending on where you live (for example under the GDPR or the CCPA), you may also have the right to
              object, restrict processing, and complain to your data protection authority. We do not sell or share
              personal data for cross-context advertising. Contact [privacy contact email] to exercise any right.
            </>,
          ]}
        />
      </Section>

      <Section id="other" title="8. Children, transfers, security and changes">
        <P>
          Chumbucket is not for anyone under 18, and we do not knowingly collect their data. Our providers may process
          data in the United States and other countries; where required we rely on standard contractual clauses. We
          protect data with access controls and encryption in transit. We will tell you in the app before material
          changes to this policy.
        </P>
      </Section>
    </LegalDoc>
  );
}
