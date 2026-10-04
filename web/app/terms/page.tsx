import type { Metadata } from "next";
import Link from "next/link";
import { Ext, LegalDoc, List, P, Section } from "@/components/legal/LegalDoc";

export const metadata: Metadata = {
  title: "Terms of Service (draft) · Chumbucket",
  description: "The draft terms for using Chumbucket, including funded trades on Panta.",
  robots: { index: false },
};

const toc = [
  { id: "who", label: "Who we are and these terms" },
  { id: "eligibility", label: "Who can use Chumbucket" },
  { id: "calls", label: "Calls, Back, Fade and Dare" },
  { id: "funded", label: "Funded positions on Panta" },
  { id: "risk", label: "Risks you accept" },
  { id: "wallets", label: "Wallets and adding funds" },
  { id: "content", label: "Your content and conduct" },
  { id: "safety", label: "Reports, blocks and moderation" },
  { id: "legacy", label: "Legacy features" },
  { id: "third", label: "Third-party services" },
  { id: "account", label: "Ending your account" },
  { id: "liability", label: "Disclaimers and liability" },
  { id: "changes", label: "Changes, law and contact" },
];

export default function TermsPage() {
  return (
    <LegalDoc
      current="/terms"
      title="Terms of Service"
      toc={toc}
      intro={
        <P>
          These terms cover the Chumbucket app and this website. By creating an account or using Chumbucket you
          agree to them. If you make a funded trade, you also confirm the eligibility statements in section 2 at that
          moment, and we record that you did.
        </P>
      }
    >
      <Section id="who" title="1. Who we are and these terms">
        <P>
          Chumbucket is operated by [Operator legal name], [registered address] (&ldquo;we&rdquo;, &ldquo;us&rdquo;).
          Chumbucket is a social network where you see what named people predict on real prediction markets, make
          your own calls, and get a receipt when the market resolves.
        </P>
        <P>
          How we handle your information is described in the <Link href="/privacy">Privacy Policy</Link>, which is part
          of these terms.
        </P>
      </Section>

      <Section id="eligibility" title="2. Who can use Chumbucket">
        <List
          items={[
            "You must be at least 18 years old, or the age of majority where you live if that is higher.",
            "You must not be located in, or a resident of, a country or region where prediction markets, event contracts or trading digital assets are prohibited, or where Panta restricts access. You must not be on a sanctions list or acting for someone who is.",
            "You may hold one account. Accounts are personal; do not let anyone else use yours.",
            "Before your first funded trade, the app asks you to confirm that you are 18 or older, that you are allowed to trade where you live, and that you accept Panta's terms. We record your confirmation, the terms version and the time. If these terms change, we ask again.",
          ]}
        />
        <P>
          We may restrict or close access where we believe these conditions are not met or where the law requires it.
          [Restricted jurisdictions to be confirmed with counsel and Panta.]
        </P>
      </Section>

      <Section id="calls" title="3. Calls, Back, Fade and Dare">
        <List
          items={[
            "A call is your free, public prediction on a market (Yes or No), optionally with a short thesis. Calling costs nothing and moves no money.",
            "Once you lock a call it cannot be edited. Its side, price at the time and timestamp are a permanent record. We may hide a call from view (for example after a report), but its result still counts toward your record.",
            "Back means you make the same call yourself. Fade means you make the opposite call. Both create a call of your own.",
            "Dare (previously labelled \"Challenge\" on calls) invites someone to go on record. It involves no money, no escrow and no transaction.",
            "Results come only from the market's venue. We do not decide outcomes. A receipt shows your call, the price when you made it and the venue's result.",
            "Calls, theses, your name, @username and picture, your record and receipts are public. Shared links can be opened by anyone.",
          ]}
        />
      </Section>

      <Section id="funded" title="4. Funded positions on Panta">
        <P>
          You may choose to put money behind your own call. Funded positions are bought on{" "}
          <Ext href="https://panta.market">Panta Market</Ext>, operated by Balr Holdings Corporation, on the Solana
          mainnet using USDC.
        </P>
        <List
          items={[
            "Funded trades are optional and separate from free calls. A call is not a trade.",
            "We prepare the transaction and show you what it does; you approve and sign it in your own wallet. We never hold your funds or your keys.",
            "Approving a transaction is not the same as a filled order. An order is filled only when Panta and the Solana network confirm it. The app shows the order's status honestly and may show it as submitted until it is confirmed.",
            "Each approval is capped at a per-trade limit the app shows before you approve.",
            "Panta's own rules, eligibility conditions and market terms apply to every funded trade, alongside these terms. [Panta end-user terms link to be confirmed.]",
            "Selling, claiming winnings and other actions are not available in the app today; use Panta's own site (panta.market) for them.",
            "The review screen shows what the transaction does before you approve it, including network costs. [Venue fees and any partner revenue share to be disclosed here before launch.]",
          ]}
        />
      </Section>

      <Section id="risk" title="5. Risks you accept">
        <List
          items={[
            "You can lose all of the money you put into a funded position.",
            "Prices move. A price shown in the app can be out of date by the time your order reaches the venue.",
            "Blockchain transactions are irreversible. A transaction sent to the wrong place or signed by mistake cannot be undone by us.",
            "Markets can be paused, cancelled or resolved in ways you did not expect, according to the venue's rules.",
            "Nothing on Chumbucket is investment, financial, legal or tax advice. Other people's calls, records and leaderboards are not recommendations, and past results do not predict future ones.",
            "You are responsible for any taxes on your trading.",
          ]}
        />
      </Section>

      <Section id="wallets" title="6. Wallets and adding funds">
        <P>
          You can connect your own Solana wallet (for example through Mobile Wallet Adapter) or use a wallet the app
          creates on your device. Either way, you control the keys. If you lose access to your wallet or its recovery
          phrase, we cannot recover it or the funds in it.
        </P>
        <P>
          Adding funds by card or bank is provided by Crossmint under its own terms, and Crossmint may verify your
          identity. We do not receive your card details.
        </P>
      </Section>

      <Section id="content" title="7. Your content and conduct">
        <P>
          You keep ownership of what you post. You give us a worldwide, non-exclusive, royalty-free licence to host,
          display and share it (including on receipts and shared links) for as long as it is on Chumbucket, and to keep
          the permanent call record described in section 3.
        </P>
        <P>You agree not to:</P>
        <List
          items={[
            "harass, threaten or abuse anyone, or post hateful, sexual or violent content;",
            "post links in theses, names or bios, spam, or promote scams;",
            "impersonate a person or organisation, or pretend to be Chumbucket or Panta;",
            "manipulate markets, records or leaderboards, including through multiple accounts or automated activity;",
            "get around rate limits, blocks or other protections, or access the service other than through our apps and published interfaces;",
            "use Chumbucket for anything illegal.",
          ]}
        />
        <P>
          We apply a basic filter that refuses links and certain words in theses, names and bios, and we limit how fast
          an account can post, respond and follow.
        </P>
      </Section>

      <Section id="safety" title="8. Reports, blocks and moderation">
        <P>
          You can report a call, a thesis or a person, and you can block or mute people. Blocking hides each of you from
          the other&rsquo;s feed and stops you responding to or following each other; muting hides someone from you only.
          We review reports and may hide calls, limit features or close accounts that break these terms. A hidden call
          stays in its author&rsquo;s record.
        </P>
      </Section>

      <Section id="legacy" title="9. Legacy features">
        <P>
          Earlier versions of Chumbucket offered SOL escrow challenges between friends and &ldquo;Arena&rdquo; football
          predictions. These are now history in the app, under Settings &rarr; History, and new escrow challenges
          cannot be created. An escrow challenge that is still open keeps its SOL in the escrow program on Solana until
          its witness settles it with their own wallet, as before: &ldquo;completed&rdquo; returns the stake to the
          challenger, &ldquo;not completed&rdquo; sends it to the witness, and the program keeps its fee (2.5%, at most
          0.1 SOL) either way. Chumbucket cannot move, refund or settle escrowed SOL for you.
        </P>
      </Section>

      <Section id="third" title="10. Third-party services">
        <P>
          Chumbucket relies on services we do not control, including Panta, Crossmint, the Solana network and its RPC
          providers, wallet apps, Google and X sign-in, Supabase, Google Firebase Cloud Messaging, Railway, Vercel,
          Tawk.to support chat and Shorebird app updates. Their terms apply to your use of them. See the{" "}
          <Link href="/privacy">Privacy Policy</Link> for what each receives.
        </P>
      </Section>

      <Section id="account" title="11. Ending your account">
        <P>
          You can delete your account at any time in the app (Profile, then Settings, then Delete account) or by
          request on <Link href="/delete-account">our deletion page</Link>. Deletion removes your name, @username,
          picture, bio, sign-ins, linked wallets, follows and push tokens. Your calls stay in the public record, shown as
          &ldquo;Deleted account&rdquo;. On-chain transactions cannot be deleted by anyone.
        </P>
        <P>We may suspend or close accounts that break these terms or where the law requires it.</P>
      </Section>

      <Section id="liability" title="12. Disclaimers and liability">
        <P>
          Chumbucket is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;. To the extent the law allows, we
          make no warranty that it will be uninterrupted, error-free or that market data is accurate or current, and we
          are not liable for trading losses, venue or network failures, or indirect or consequential losses. [Liability
          cap and consumer-law carve-outs to be drafted by counsel.]
        </P>
      </Section>

      <Section id="changes" title="13. Changes, law and contact">
        <P>
          We will tell you in the app before material changes take effect. If you keep using Chumbucket after that, the
          new terms apply; funded trading asks you to confirm again. These terms are governed by [governing law], and
          disputes go to [forum]. Contact: [contact email], or Talk to Support in the app.
        </P>
      </Section>
    </LegalDoc>
  );
}
