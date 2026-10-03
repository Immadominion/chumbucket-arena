/**
 * The hero's folded-ribbon illustration: a black band with two labelled
 * stops, a pink band folding down into a pink tag, a sparkle and the big
 * tilted "a". One SVG on the Figma artboard's own coordinates (588 x 358),
 * so it scales as a single piece; every part has a data-el hook for motion.
 *
 * Decorative (aria-hidden): the same story is told in text further down.
 */

import { SPARKLE_PATH } from "../icons";

/* Figma transforms, kept verbatim: the bands are turned -45.7 and -28 degrees. */
const STEEP = "0.698 -0.716 0.716 0.698";
const SHALLOW = "0.883 -0.469 0.469 0.883";

/** First-line baseline for 11.76px text in an 18.3px line (Machina metrics). */
const BASE_1 = 12.12;
const BASE_2 = BASE_1 + 18.299;

export const RIBBON_COPY = {
  stopOne: { title: "What is it?", body: "Calls on real markets" },
  stopTwo: { title: "How it works", body: "Panta settles it" },
  fold: "Make a call",
  tag: { title: "Get started", body: "get the app" },
};

export function HeroRibbon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const c = RIBBON_COPY;
  return (
    <svg
      className={`cb-ribbon ${className ?? ""}`}
      data-el="hero.ribbon"
      viewBox="0 0 588 357.738"
      style={style}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id="cb-ribbon-clip">
          <rect x="56.639" y="0" width="531.361" height="313.918" />
        </clipPath>
        <clipPath id="cb-ribbon-band-clip">
          <rect x="0" y="0" width="505.308" height="313.918" />
        </clipPath>
        <clipPath id="cb-ribbon-stops-clip">
          <rect x="0" y="0" width="486.462" height="37.299" />
        </clipPath>
      </defs>

      <g filter="url(#cb-grain)">
        <g clipPath="url(#cb-ribbon-clip)">
          <g transform="translate(56.639 0)">
            {/* pink tag (bottom right) */}
            <g data-el="hero.ribbon.tag">
              <path
                className="cb-ribbon__pink"
                transform="translate(256.361 237.25)"
                d="M0.151 7.981C0.162 3.57 3.74 0 8.151 0L267 0C271.418 0 275 3.582 275 8L275 62.991C275 67.413 271.413 70.996 266.991 70.991L8.01 70.684C3.588 70.679 0.009 67.087 0.019 62.665L0.151 7.981Z"
              />
              <path transform={`matrix(${STEEP} 272.305 280.388)`} d="M6.739 0.13L58.66 0L58.66 21.605L0 21.605L6.739 0.13Z" />
              <path
                data-el="hero.ribbon.sparkle"
                transform="translate(335.256 252.242) scale(0.6535)"
                d={SPARKLE_PATH}
              />
              <rect x="392.766" y="237.211" width="1.307" height="71.234" />
              <rect x="318.265" y="237.211" width="1.307" height="71.234" />
            </g>

            {/* pink band folding down to the tag */}
            <g data-el="hero.ribbon.fold">
              <path
                className="cb-ribbon__pink"
                transform={`matrix(${STEEP} 208.278 262.348)`}
                d="M38.226 4.469C39.646 1.972 42.296 0.429 45.168 0.425L344.737 0.011C349.159 0.005 352.748 3.588 352.748 8.011L352.748 63.659C352.748 68.077 349.166 71.659 344.748 71.659L13.755 71.659C7.62 71.659 3.768 65.036 6.802 59.703L38.226 4.469Z"
              />
              <text className="cb-ribbon__label cb-ribbon__label--bold" transform={`matrix(${STEEP} 281.014 226.101)`} y={BASE_1}>
                {c.fold}
              </text>
            </g>

            {/* black band with its two stops */}
            <g clipPath="url(#cb-ribbon-band-clip)" data-el="hero.ribbon.band">
              <rect width="534.315" height="71.434" rx="8" transform={`matrix(${SHALLOW} 0 250.846)`} />
              <g transform={`matrix(${SHALLOW} 30.062 254.202)`}>
                <g clipPath="url(#cb-ribbon-stops-clip)">
                  <g data-el="hero.ribbon.stop-1">
                    <circle className="cb-ribbon__dot" cx="15.685" cy="18.298" r="15.358" />
                    <text className="cb-ribbon__label cb-ribbon__label--bold cb-ribbon__label--light" x="41.825" y={BASE_1}>
                      {c.stopOne.title}
                    </text>
                    <text className="cb-ribbon__label cb-ribbon__label--light" x="41.825" y={BASE_2}>
                      {c.stopOne.body}
                    </text>
                  </g>
                  <line x1="251.235" y1="0.818" x2="230.976" y2="35.906" stroke="#fff" strokeWidth="0.654" />
                  <g data-el="hero.ribbon.stop-2" transform="translate(266.637 0)">
                    <circle className="cb-ribbon__dot" cx="15.685" cy="18.298" r="15.358" />
                    <text className="cb-ribbon__label cb-ribbon__label--bold cb-ribbon__label--light" x="41.825" y={BASE_1}>
                      {c.stopTwo.title}
                    </text>
                    <text className="cb-ribbon__label cb-ribbon__label--light" x="41.825" y={BASE_2}>
                      {c.stopTwo.body}
                    </text>
                  </g>
                </g>
              </g>
            </g>

            {/* the tag's label */}
            <g data-el="hero.ribbon.tag-label">
              <text className="cb-ribbon__label cb-ribbon__label--bold" x="400.758" y={253.549 + BASE_1}>
                {c.tag.title}
              </text>
              <text className="cb-ribbon__label cb-ribbon__label--small" x="402.758" y="284.94">
                {c.tag.body}
              </text>
            </g>
          </g>
        </g>

        {/* the big tilted "a" the ribbon hangs from */}
        <text className="cb-ribbon__glyph" data-el="hero.ribbon.glyph" transform={`matrix(${SHALLOW} 0 263.263)`} y="80.05">
          a
        </text>
      </g>
    </svg>
  );
}
