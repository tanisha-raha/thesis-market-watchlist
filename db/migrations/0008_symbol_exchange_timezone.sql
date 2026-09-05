-- Exchange-local clock for each security, straight from the provider.
--
-- Additive and nullable on purpose: every existing symbol, watchlist item,
-- thesis and event stays exactly as it is. Rows written before this column
-- existed simply carry NULL and fall back to inference from the exchange and
-- currency we already store, until the next poll fills them in.
ALTER TABLE "symbols" ADD COLUMN "exchange_timezone" text;
