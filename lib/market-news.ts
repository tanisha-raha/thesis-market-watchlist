import { XMLParser } from "fast-xml-parser";
import { normalizeNews } from "./market-brief";
export const NEWS_FEED = "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms";
export function parseMarketNews(xml: string, now = new Date()) {
  if (xml.length > 256000 || /<!DOCTYPE|<!ENTITY/i.test(xml)) return [];
  try {
    const parsed = new XMLParser({ processEntities: false, ignoreAttributes: true, parseTagValue: false }).parse(xml);
    const source = parsed?.rss?.channel?.item;
    const items = Array.isArray(source) ? source : source ? [source] : [];
    return normalizeNews(items.slice(0, 50).map((i: { title?: unknown; link?: unknown; pubDate?: unknown }) => ({ title: i.title, link: i.link, publisher: "The Economic Times", providerPublishTime: i.pubDate })), now)
      .filter((item) => new URL(item.url).hostname === "economictimes.indiatimes.com");
  } catch { return []; }
}
/** Fixed publisher endpoint, bounded payload, abortable transport; presentation only. */
export async function fetchMarketNews(fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher(NEWS_FEED, { signal: AbortSignal.timeout(7000), redirect: "error" });
    if (!response.ok || !response.body) return [];
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 256000) { await reader.cancel(); return []; } chunks.push(value); } }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parseMarketNews(new TextDecoder().decode(bytes));
  } catch { return []; }
}
