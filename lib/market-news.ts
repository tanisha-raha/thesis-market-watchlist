import { XMLParser } from "fast-xml-parser";
import { normalizeNews } from "./market-brief";

/**
 * Market headlines, from publishers' own RSS.
 *
 * WHY A CHAIN AND NOT ONE FEED. A single publisher endpoint is a single point of
 * failure the product does not control: a CDN that answers a laptop happily can
 * refuse a datacenter IP, rate-limit it, or redirect it, and the card then reads
 * "unavailable" while the feed is demonstrably fine from anywhere else. Each
 * source below is a public RSS feed of Indian market coverage, tried in order,
 * and the first that yields usable items wins. Nothing is merged, so the card
 * still speaks with one publisher's voice — and every item carries the real
 * publisher it came from.
 *
 * WHAT DOES NOT CHANGE. This is presentation context only. No headline reaches
 * detection, thesis evaluation, Thesis Health or the anomaly layer, and THESIS
 * never claims a headline explains a price move.
 */
export type NewsSource = { url: string; publisher: string; host: string };

export const NEWS_SOURCES: NewsSource[] = [
  { url: "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms", publisher: "The Economic Times", host: "economictimes.indiatimes.com" },
  { url: "https://www.livemint.com/rss/markets", publisher: "Mint", host: "www.livemint.com" },
  { url: "https://www.thehindubusinessline.com/markets/feeder/default.rss", publisher: "businessline", host: "www.thehindubusinessline.com" },
];

/** The primary feed. Kept as a named export because tests and docs refer to it. */
export const NEWS_FEED = NEWS_SOURCES[0].url;

/**
 * Identifies the client to publishers.
 *
 * Honest rather than a browser impersonation: several publisher CDNs reject the
 * default runtime user-agent outright, which is the difference between a feed
 * that works from a laptop and one that 403s from a serverless function.
 */
const USER_AGENT = "THESIS/1.0 (+https://thesis-market-watchlist.vercel.app)";

const MAX_BYTES = 256000;

/**
 * The five predefined XML entities, and only those.
 *
 * The parser runs with entity processing off so a hostile feed cannot expand
 * anything, and declarations are rejected outright above. That leaves the
 * ordinary escapes an honest publisher uses — "Reliance &amp; Co", a query
 * string in a link — which have to be turned back into characters or the page
 * shows the escape instead of the headline.
 */
const decodeXml = (value: string) => value
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

const text = (value: unknown) => typeof value === "string" ? decodeXml(value) : value;

export function parseMarketNews(xml: string, now = new Date(), source: NewsSource = NEWS_SOURCES[0]) {
  if (xml.length > MAX_BYTES || /<!DOCTYPE|<!ENTITY/i.test(xml)) return [];
  try {
    const parsed = new XMLParser({ processEntities: false, ignoreAttributes: true, parseTagValue: false }).parse(xml);
    const channel = parsed?.rss?.channel?.item;
    const items = Array.isArray(channel) ? channel : channel ? [channel] : [];
    return normalizeNews(
      items.slice(0, 50).map((i: { title?: unknown; link?: unknown; pubDate?: unknown }) =>
        ({ title: text(i.title), link: text(i.link), publisher: source.publisher, providerPublishTime: i.pubDate })),
      now,
    // The publisher's own host, so a redirected or substituted feed cannot put
    // somebody else's link on the page under this publisher's name.
    ).filter((item) => new URL(item.url).hostname === source.host);
  } catch { return []; }
}

/** Bounded payload, abortable transport, one publisher. Presentation only. */
async function fetchSource(source: NewsSource, fetcher: typeof fetch): Promise<ReturnType<typeof parseMarketNews>> {
  try {
    const response = await fetcher(source.url, {
      signal: AbortSignal.timeout(7000),
      headers: { "user-agent": USER_AGENT, accept: "application/rss+xml, application/xml;q=0.9, text/xml;q=0.9" },
    });
    if (!response.ok || !response.body) return [];
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > MAX_BYTES) { await reader.cancel(); return []; } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parseMarketNews(new TextDecoder().decode(bytes), new Date(), source);
  } catch { return []; }
}

/**
 * The first source that actually has recent headlines.
 *
 * Sequential on purpose: the primary answers on almost every request, so the
 * others cost nothing, and asking three publishers in parallel for something
 * only one of them will supply is rude to all three.
 */
export async function fetchMarketNews(fetcher: typeof fetch = fetch) {
  for (const source of NEWS_SOURCES) {
    const items = await fetchSource(source, fetcher);
    if (items.length) return items;
  }
  return [];
}
