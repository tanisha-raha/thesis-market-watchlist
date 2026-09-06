/**
 * The vocabulary Ask THESIS can explain without asking anyone else.
 *
 * WHY THIS EXISTS AND IS NOT A PILE OF CANNED REPLIES. A general finance
 * question is a question about a *concept*, not about a phrasing, so this is a
 * concept table with the concept's own synonyms attached, matched anywhere in a
 * sentence. "What is volatility", "explain volatility to me" and "how is
 * realized vol measured" all resolve to the same entry, and an entry the table
 * does not hold is passed to the configured conversational model rather than
 * guessed at.
 *
 * It also fixes something a general model cannot: for the measurements THESIS
 * itself computes, the honest answer includes *how this product computes them*.
 * A model asked "what is relative volume" will give a textbook answer that may
 * not match the 20-session median this engine actually divides by, and a user
 * comparing the answer with a stored evidence tile would be right to call that
 * a contradiction. `inThesis` is where the product speaks for itself.
 *
 * Nothing here reads a database, a quote, or a user. It is definitions only:
 * no figure in this file describes any company, and none ever will.
 */

export type FinanceConcept = {
  id: string;
  /** How the concept is named back to the reader. */
  term: string;
  /** Forms a person might actually type. Matched with word boundaries. */
  aliases: string[];
  explanation: string;
  /** How THESIS measures or uses it — present only where THESIS actually does. */
  inThesis?: string;
};

export const FINANCE_CONCEPTS: FinanceConcept[] = [
  {
    id: "volatility", term: "Volatility",
    aliases: ["volatility", "realized volatility", "realised volatility", "historical volatility", "vol"],
    explanation: "Volatility measures how much a price moves around, not which direction it moves in. It is usually the standard deviation of recent returns: a stock whose daily returns cluster near zero is low-volatility, one that swings several percent a day is high-volatility. It says nothing about whether a price will rise or fall — only how large the typical move has been.",
    inThesis: "realized volatility is the standard deviation of the last 20 daily log returns, and it is the yardstick a move is measured against, so a “2.3σ move” means 2.3 times that number.",
  },
  {
    id: "standard-deviation", term: "Standard deviation (sigma)",
    aliases: ["standard deviation", "sigma", "σ", "std dev"],
    explanation: "Standard deviation summarises how far a set of numbers typically sits from their average. In markets it is applied to returns: one standard deviation covers the ordinary day, and moves of two or three are progressively rarer. It is a description of a distribution, not a probability that anything will repeat.",
    inThesis: "a move is expressed in sigma against the symbol's own 20-day realized volatility, so the same percentage move counts as larger for a normally quiet stock.",
  },
  {
    id: "z-score", term: "Z-score",
    aliases: ["z-score", "z score", "zscore"],
    explanation: "A z-score restates a value as the number of standard deviations it sits from an average. It makes quantities on different scales comparable — a 3% move and a 30% volume rise can both be expressed as “how unusual is this, for this series”. A high z-score means the observation is far from typical, nothing more.",
    inThesis: "the deterministic change engine fires on a return z-score against 20-day realized volatility, with separate thresholds for firing and clearing so a value hovering on the line cannot flicker.",
  },
  {
    id: "beta", term: "Beta",
    aliases: ["beta"],
    explanation: "Beta measures how much a stock has historically moved when its market index moved. A beta of 1 means it tended to track the index; above 1 means it amplified the index's moves, below 1 means it damped them, and a negative beta means it tended to move the other way. It is a backward-looking regression slope, not a forecast, and it says nothing about company quality.",
    inThesis: "beta is estimated over 60 sessions against the security's own market index — an Indian listing against NIFTY 50, a US listing against the S&P 500 — and is left blank rather than borrowed from another market when that history is not stored.",
  },
  {
    id: "benchmark", term: "Benchmark",
    aliases: ["benchmark", "market index", "index"],
    explanation: "A benchmark is the index a security's behaviour is compared against, so that a move can be separated into “the whole market did this” and “this company did this”. Choosing the right one matters: comparing a US listing to an Indian index would attribute an ordinary session to the company.",
    inThesis: "each security carries its own benchmark, and residual moves are measured after removing beta times the benchmark's return for the same session.",
  },
  {
    id: "correlation", term: "Correlation",
    aliases: ["correlation", "correlated"],
    explanation: "Correlation measures whether two series tend to move together, on a scale from +1 (they move in step) through 0 (no linear relationship) to −1 (they move oppositely). It is a statement about co-movement only: two things can be highly correlated with neither causing the other.",
  },
  {
    id: "breakout", term: "Breakout",
    aliases: ["breakout", "break out", "breaks out"],
    explanation: "A breakout is a price moving decisively beyond a level it had been contained by — a recent high, a range top, a round number people watch. Traders usually ask for confirmation, most often heavier-than-usual volume, because a move beyond a level on thin trading often reverses. The level is a description of past trading, not a rule the market has agreed to.",
    inThesis: "a breakout condition is confirmed only when the close is beyond the level you set and volume exceeds the recent median, so a quiet drift past a level is not reported as one.",
  },
  {
    id: "support-resistance", term: "Support and resistance",
    aliases: ["support and resistance", "support level", "resistance level", "support", "resistance"],
    explanation: "Support and resistance are price areas where a market has repeatedly stopped falling or stopped rising. They are observations about where trading has previously clustered, and they are descriptive: a level holding many times does not oblige it to hold again.",
  },
  {
    id: "relative-volume", term: "Relative volume",
    aliases: ["relative volume", "rvol", "volume ratio", "unusual volume"],
    explanation: "Relative volume compares today's traded quantity with what is normal for that security, usually as a ratio to a recent median or average. It answers “are more people than usual trading this”, which is why it is used to separate a move that attracted participation from one that happened on an ordinary day.",
    inThesis: "relative volume is the session's volume divided by the 20-session median, and a volume event requires roughly twice the median before it is recorded.",
  },
  {
    id: "volume", term: "Trading volume",
    aliases: ["trading volume", "volume", "turnover"],
    explanation: "Volume is the number of shares traded in a period. High volume means many participants transacted, which is often read as conviction behind a move; low volume means the price moved on relatively few trades. Volume is a fact about activity, not about direction.",
  },
  {
    id: "liquidity", term: "Liquidity",
    aliases: ["liquidity", "liquid", "illiquid"],
    explanation: "Liquidity describes how easily a position can be bought or sold without moving the price much. A liquid security has many buyers and sellers, tight spreads and steady volume; an illiquid one can move sharply on a modest order. Liquidity tends to fall exactly when markets are stressed.",
  },
  {
    id: "spread", term: "Bid-ask spread",
    aliases: ["bid-ask spread", "bid ask spread", "bid-offer spread", "spread"],
    explanation: "The bid is the highest price a buyer is currently willing to pay, the ask the lowest a seller will accept, and the spread is the gap between them. It is a real cost of transacting: crossing the spread means buying at the ask and selling at the bid. Narrow spreads indicate a liquid, actively quoted market.",
  },
  {
    id: "gap", term: "Gap",
    aliases: ["gap", "overnight gap", "opening gap", "gaps up", "gaps down"],
    explanation: "A gap is a difference between one session's close and the next session's open, with no trading in between at those prices. It usually reflects information that arrived while the exchange was shut. Because it happens outside trading hours, a gap is not something an intraday stop or a limit inside the gap can protect against.",
    inThesis: "the overnight gap is measured from the previous close to the session open and is detected separately from the intraday move, so the two are never reported as one event.",
  },
  {
    id: "moving-average", term: "Moving average",
    aliases: ["moving average", "simple moving average", "sma", "20-day average", "20 day average"],
    explanation: "A moving average is the mean price over a trailing window, recomputed each session, which smooths out day-to-day noise to show the recent level. A short window follows the price closely; a long one lags more. It is a summary of prices already seen and carries no predictive claim.",
    inThesis: "a 20-session moving average of adjusted closes is stored as a reference level on each company page.",
  },
  {
    id: "fifty-two-week", term: "52-week high and low",
    aliases: ["52-week high", "52 week high", "52-week low", "52 week low", "52-week range", "52 week range"],
    explanation: "The 52-week high and low are the extremes of a security's price over the past year. They are widely watched as reference points, mostly because they are easy to see rather than because they carry information; a price near either simply says where the last year's trading sat.",
    inThesis: "both are computed from adjusted closes, so a split does not create a phantom new high or low.",
  },
  {
    id: "adjusted-close", term: "Adjusted close",
    aliases: ["adjusted close", "adjusted price", "adjusted closes", "split adjusted"],
    explanation: "An adjusted close restates historical prices so that corporate actions — splits, bonus issues, dividends — do not appear as price moves. Without adjustment, a 2-for-1 split looks like a 50% crash. Comparisons across time should use adjusted series; the raw close is what actually printed on the day.",
    inThesis: "statistics, replays and benchmark comparisons run on adjusted closes, while the raw close is still stored so a restatement is visible rather than silent.",
  },
  {
    id: "drawdown", term: "Drawdown",
    aliases: ["drawdown", "draw down", "peak to trough"],
    explanation: "A drawdown is the decline from a previous peak to a subsequent trough, usually quoted as a percentage. It describes the worst stretch an investor would have sat through, which is why it is often reported alongside returns: two investments with the same return can have very different drawdowns.",
  },
  {
    id: "momentum", term: "Momentum",
    aliases: ["momentum", "trending", "trend following"],
    explanation: "Momentum is the observation that recent relative performance has sometimes persisted over certain horizons. As a description it just means “this has been rising or falling for a while”. As a strategy it is a bet that the tendency continues, and it reverses sharply and without warning.",
  },
  {
    id: "mean-reversion", term: "Mean reversion",
    aliases: ["mean reversion", "reverts to the mean", "mean reverting"],
    explanation: "Mean reversion is the idea that a quantity that has moved far from its average tends to come back toward it. It describes some series well — volatility, spreads — and prices far less reliably. A price being “far from average” is not evidence that it will return.",
  },
  {
    id: "market-cap", term: "Market capitalisation",
    aliases: ["market capitalisation", "market capitalization", "market cap", "mcap"],
    explanation: "Market capitalisation is the share price multiplied by the number of shares outstanding — what the equity of the business is currently priced at in total. It is the usual way companies are sorted into large, mid and small cap. It measures only the equity, and ignores what the company owes.",
  },
  {
    id: "enterprise-value", term: "Enterprise value",
    aliases: ["enterprise value", "ev/ebitda", "ev to ebitda"],
    explanation: "Enterprise value is market capitalisation plus net debt (debt minus cash) — roughly what it would cost to acquire the whole business, including taking on its borrowings. Compared with market cap, it does not flatter a company that is cheap on equity only because it is heavily indebted, which is why multiples such as EV/EBITDA use it instead.",
  },
  {
    id: "pe-ratio", term: "Price-to-earnings ratio",
    aliases: ["price-to-earnings", "price to earnings", "p/e ratio", "p/e", "pe ratio", "earnings multiple"],
    explanation: "The P/E ratio divides the share price by earnings per share, giving the price paid for each unit of annual profit. A high P/E means the market expects growth or sees low risk; a low one can mean scepticism or a bargain. It is only comparable between businesses with similar accounting, growth and cyclicality.",
  },
  {
    id: "eps", term: "Earnings per share",
    aliases: ["earnings per share", "eps"],
    explanation: "Earnings per share is net profit divided by the number of shares outstanding — the share of profit attributable to each share. It is the denominator in the P/E ratio, and it can be moved by buybacks and issuance as well as by the business itself.",
  },
  {
    id: "ebitda", term: "EBITDA",
    aliases: ["ebitda"],
    explanation: "EBITDA is earnings before interest, tax, depreciation and amortisation — an approximation of operating profitability before financing and accounting choices. It makes companies with different debt loads and asset lives easier to compare, but it excludes real costs: capital equipment does wear out, and interest does have to be paid.",
  },
  {
    id: "free-cash-flow", term: "Free cash flow",
    aliases: ["free cash flow", "fcf"],
    explanation: "Free cash flow is the cash a business generates from operations after the capital spending needed to keep running. Unlike accounting profit it is hard to create with judgement calls, which is why it is watched as a reality check on reported earnings.",
  },
  {
    id: "book-value", term: "Book value",
    aliases: ["book value", "price to book", "p/b ratio"],
    explanation: "Book value is assets minus liabilities as carried in the accounts — the balance-sheet value of the equity. Price-to-book compares the market's valuation with it. It is most informative for asset-heavy businesses and least for ones whose value is people, brands or software.",
  },
  {
    id: "roe", term: "Return on equity",
    aliases: ["return on equity", "roe"],
    explanation: "Return on equity is net profit divided by shareholders' equity: how much profit the business produces per unit of capital the owners have in it. A high ROE can reflect genuine efficiency or simply a lot of leverage, so it is read alongside debt.",
  },
  {
    id: "debt-to-equity", term: "Debt-to-equity ratio",
    aliases: ["debt-to-equity", "debt to equity", "gearing", "leverage ratio"],
    explanation: "Debt-to-equity compares borrowed money with shareholders' equity, measuring how much of the business is financed by lenders. Leverage magnifies both good and bad outcomes, and what counts as high depends entirely on how stable the industry's cash flows are.",
  },
  {
    id: "dividend", term: "Dividend",
    aliases: ["dividend", "dividends", "ex-dividend", "payout ratio"],
    explanation: "A dividend is cash a company pays out to shareholders from its profits. On the ex-dividend date the share price typically drops by roughly the dividend, because the buyer no longer receives it — a fall that is mechanical rather than a market judgement.",
    inThesis: "price history is adjusted for corporate actions so a mechanical ex-dividend drop is not detected as a market event.",
  },
  {
    id: "dividend-yield", term: "Dividend yield",
    aliases: ["dividend yield", "yield"],
    explanation: "Dividend yield is annual dividends per share divided by the share price. It rises when the price falls, so an unusually high yield often signals that the market doubts the dividend will be maintained rather than that the shares are cheap.",
  },
  {
    id: "corporate-action", term: "Corporate action",
    aliases: ["corporate action", "corporate actions"],
    explanation: "A corporate action is an event initiated by the company that changes its shares — a split, bonus issue, rights issue, dividend, merger or delisting. Several change the price mechanically without changing the value of a holding, so historical series have to be restated for them.",
    inThesis: "a validated corporate action pauses replay and rescales any affected saved condition, showing the before and after rather than silently rewriting what you set.",
  },
  {
    id: "stock-split", term: "Stock split and bonus issue",
    aliases: ["stock split", "share split", "bonus issue", "split", "reverse split"],
    explanation: "A split divides each share into several, and a bonus issue distributes additional shares to existing holders. Both multiply the share count and divide the price by the same factor, so the value of a holding is unchanged. Unadjusted charts show them as sudden crashes.",
  },
  {
    id: "rights-issue", term: "Rights issue",
    aliases: ["rights issue", "rights offering"],
    explanation: "A rights issue offers existing shareholders the chance to buy new shares, usually below the market price, in proportion to what they already hold. It raises capital from current owners; holders who do not take up their rights are diluted.",
  },
  {
    id: "free-float", term: "Free float",
    aliases: ["free float", "free-float", "floating stock"],
    explanation: "Free float is the portion of shares actually available to trade, excluding blocks held by promoters, governments or strategic holders. A small float means a given order moves the price more, and most modern indices weight their members by free float rather than total market cap.",
  },
  {
    id: "short-selling", term: "Short selling",
    aliases: ["short selling", "short sell", "shorting", "short interest"],
    explanation: "Short selling is selling borrowed shares in the hope of buying them back cheaper, profiting if the price falls. Losses are unbounded because a price can keep rising, and heavily shorted stocks can spike as shorts are forced to repurchase.",
  },
  {
    id: "order-types", term: "Market and limit orders",
    aliases: ["limit order", "market order", "stop loss", "stop-loss", "order type"],
    explanation: "A market order executes immediately at whatever price is available; a limit order executes only at your price or better, and may not execute at all. A stop order becomes live once a trigger price trades. The trade-off is always certainty of execution against certainty of price.",
  },
  {
    id: "circuit-breaker", term: "Circuit breaker",
    aliases: ["circuit breaker", "circuit limit", "price band", "upper circuit", "lower circuit"],
    explanation: "A circuit breaker halts or limits trading when a price or index moves beyond a set percentage, pausing the market so participants can react to information rather than to each other. Indian exchanges apply both index-level halts and per-security price bands.",
  },
  {
    id: "etf", term: "Exchange-traded fund",
    aliases: ["exchange-traded fund", "exchange traded fund", "etf", "index fund"],
    explanation: "An ETF is a fund whose units trade on an exchange like a share, usually tracking an index. It offers diversification in a single instrument at low cost; what it holds, how closely it tracks, and how liquid its units are still vary a great deal between funds.",
  },
  {
    id: "ipo", term: "Initial public offering",
    aliases: ["initial public offering", "ipo", "listing day"],
    explanation: "An IPO is a company's first sale of shares to the public, after which they trade on an exchange. There is no trading history before it, so the statistical measures used on established shares — volatility, beta, medians — need time before they mean anything.",
  },
  {
    id: "market-hours", term: "Pre-market and after-hours trading",
    aliases: ["pre-market", "premarket", "after-hours", "after hours", "extended hours", "market state"],
    explanation: "Some markets allow trading outside the main session, in thinner conditions with wider spreads. Prices printed then can move sharply on small orders and are not always representative of where the security opens the following session.",
    inThesis: "each quote carries the exchange's own reported session state and is shown on that exchange's clock, so an after-hours print is never presented as a regular-session close.",
  },
  {
    id: "delayed-data", term: "Delayed market data",
    aliases: ["delayed data", "delayed quote", "real-time data", "stale data", "last known good"],
    explanation: "Most freely available market data is delayed by some minutes and can be revised. An honest interface therefore shows the timestamp of the data it is displaying rather than implying it is live, so that a decision is never made on a number whose age is unknown.",
    inThesis: "every price is shown with the exchange time it was reported and a freshness label, and a failed update keeps the last known good value rather than blanking or inventing one.",
  },
  {
    id: "anomaly-detection", term: "Anomaly detection",
    aliases: ["anomaly detection", "isolation forest", "outlier detection", "unsupervised learning"],
    explanation: "Anomaly detection finds observations that do not resemble the rest of a dataset, without being told in advance what an anomaly looks like. Isolation Forest does it by randomly partitioning the data and noticing which points get separated in very few cuts. It identifies unusual combinations; it does not explain them or predict anything.",
    inThesis: "the anomaly layer is secondary evidence only. It classifies a session's recorded signals as unusual or typical for that company and never overrides the deterministic engine, which alone decides what changed.",
  },
  {
    id: "backtest", term: "Backtest",
    aliases: ["backtest", "backtesting", "back test", "historical simulation"],
    explanation: "A backtest replays a rule over historical data to see how it would have behaved. It is easy to make one look good by tuning it to the past, and results are sensitive to restatements, survivorship and the fact that a rule chosen after seeing the data has already used it.",
    inThesis: "THESIS Replay walks your saved condition over observed daily closes and reports what occurred. It is a historical description, never a strategy result or a projection.",
  },
  {
    id: "interest-rates", term: "Interest rates and share prices",
    aliases: ["interest rate", "interest rates", "rate hike", "rate cut", "central bank rate", "repo rate", "fed funds", "monetary policy", "rates rise", "rates fall"],
    explanation: "A share is worth the cash a business is expected to produce, discounted back to today, so the rate used to discount it matters. When rates rise, future cash is worth less now and safe bonds start paying a competitive return, which pulls money away from equities; borrowing also costs the company more. The effect is uneven: companies whose value sits far in the future — early-stage, high-growth, long-duration — reprice hardest, while banks can benefit from wider margins. Rates are one input among many, and markets usually move on the surprise relative to what was expected rather than on the change itself.",
  },
  {
    id: "revenue-vs-profit", term: "Revenue and profit",
    aliases: ["revenue", "turnover and profit", "revenue and profit", "sales and profit", "top line", "bottom line", "gross profit", "operating profit", "net profit", "net income"],
    explanation: "Revenue is everything a business bills its customers — the top line, before any cost is taken out. Profit is what survives after costs: gross profit after the direct cost of what was sold, operating profit after running the business, and net profit after interest and tax. A company can grow revenue quickly and still lose money, which is why the two are never interchangeable. Margin — profit divided by revenue — is the usual way to compare how much of each unit of sales a business actually keeps.",
  },
  {
    id: "fundamental-analysis", term: "Fundamental analysis",
    aliases: ["fundamental analysis", "fundamentals", "fundamental research"],
    explanation: "Fundamental analysis values a business from what it does: revenue, margins, cash generation, debt, competitive position, management and the industry it sits in, compared against the price being asked for it. The working assumption is that price and value can diverge for a long time but are ultimately connected. It says nothing about timing, and its main risks are that the inputs are estimates and the future can differ from any of them.",
  },
  {
    id: "technical-analysis", term: "Technical analysis",
    aliases: ["technical analysis", "chart analysis", "charting", "price action"],
    explanation: "Technical analysis studies price and volume history — trends, levels, patterns, momentum — rather than the underlying business, on the view that participant behaviour leaves repeatable traces. It is descriptive by nature: a level held three times is an observation, not an obligation. Its usual failure mode is finding patterns in noise, which is why the disciplined version of it insists on rules that were defined before the data was seen.",
  },
  {
    id: "diversification", term: "Diversification",
    aliases: ["diversification", "diversify", "diversified", "concentration risk"],
    explanation: "Diversification is holding assets whose outcomes are not driven by the same thing, so that one going wrong does not take everything with it. It reduces the risk specific to a company or sector; it cannot remove the risk that the whole market falls, and correlations tend to rise exactly when that happens. Beyond a moderate number of genuinely different holdings the benefit flattens, and past that point it mostly dilutes attention.",
  },
  {
    id: "compound-interest", term: "Compound interest",
    aliases: ["compound interest", "compounding", "compound growth", "compounded annually"],
    explanation: "Compounding is earning a return on returns already earned, so growth accelerates the longer it runs. At 8% a year, money roughly doubles in nine years and quadruples in eighteen — the second doubling comes from the same rate applied to a larger base. It works identically against you on borrowings, and its effect is dominated by time and by the consistency of the rate, which is why costs and interruptions matter more than they first appear.",
  },
  {
    id: "earnings-reaction", term: "Why a stock can fall on good earnings",
    aliases: ["fall after good earnings", "drop after earnings", "falls on good results", "good earnings but", "earnings reaction", "priced in", "beat expectations"],
    explanation: "A share price already reflects what the market expects, so results are judged against that expectation rather than against zero. A company can grow strongly and still disappoint if the market had assumed more, or if guidance, margins, or one segment came in weaker than the headline. Buying ahead of the announcement can also leave nobody left to buy afterwards. This is why \"good result, lower price\" is ordinary rather than irrational — the news was already in the price.",
  },
  {
    id: "sector-drivers", term: "What moves technology shares",
    aliases: ["technology stocks", "tech stocks", "technology companies", "tech sector", "technology sector", "sector drivers", "cyclical stocks", "defensive stocks"],
    explanation: "Sectors respond to different things. Technology companies typically earn much of their value from cash expected years out, which makes them unusually sensitive to interest rates and to shifts in growth expectations; they are also exposed to capital-spending cycles at their customers, to supply chains, and increasingly to regulation. Banks move with rates and credit quality, energy with commodity prices, consumer staples least of all — which is the difference between a cyclical and a defensive business.",
  },
  {
    id: "comparing-stocks", term: "Comparing two companies",
    aliases: ["comparing two stocks", "compare two stocks", "comparing stocks", "compare two companies", "what should i look at", "how do i compare", "comparison framework"],
    explanation: "A useful comparison starts with what the businesses actually do and how they make money, because two companies in different industries are rarely comparable on the same ratios. From there: growth and margins over several years rather than one; cash generation against reported profit; balance-sheet strength and debt; the durability of the competitive position; and only then valuation — and valuation compared against each company's own history and its peers, not across sectors. Alongside that sits behaviour: how volatile each has been, how each moves relative to its market, and how liquid it is. Currency, exchange and accounting standards have to match before any cross-market number means anything.",
  },
  {
    id: "evaluating-a-company", term: "Evaluating a single company",
    aliases: ["evaluate a company", "evaluating a company", "how to evaluate", "what to look for in a stock", "research a stock", "due diligence"],
    explanation: "The questions that do most of the work: what does the business sell and to whom; is revenue growing and are margins holding; does reported profit turn into cash; how much debt sits against it and on what terms; what stops a competitor doing the same thing; who runs it and how they are paid; and what price is being asked relative to all of that. Then the honest part — what would have to be true for this to work out, and what would tell you it is not working. Writing that second answer down before buying is the discipline most people skip.",
  },
  {
    id: "risk", term: "Risk",
    aliases: ["risk", "risky", "risk tolerance", "downside risk", "systematic risk", "unsystematic risk"],
    explanation: "In markets, risk usually means the range of outcomes rather than the chance of a bad one. Some of it is specific to a company and can be diversified away; the rest belongs to the whole market and cannot. Volatility is the common proxy because it is measurable, but it describes fluctuation, not the permanent loss of capital — which is the risk that actually matters and is much harder to put a number on.",
  },
  {
    id: "inflation", term: "Inflation",
    aliases: ["inflation", "inflationary", "cpi", "consumer price index", "deflation"],
    explanation: "Inflation is the rate at which the purchasing power of money falls. It matters to shares in two ways: it erodes the real value of future cash, and it usually provokes higher interest rates, which lowers what that cash is worth today. Businesses that can raise prices without losing customers cope better than those that cannot, so pricing power becomes the thing to look for in an inflationary period.",
  },
  {
    id: "portfolio-allocation", term: "Asset allocation",
    aliases: ["asset allocation", "allocation", "portfolio construction", "rebalancing", "position sizing"],
    explanation: "Allocation is how holdings are split across asset types and, within equities, across companies and sectors. It is generally a larger determinant of a portfolio's behaviour than the choice of any individual holding. Rebalancing — restoring the intended proportions after prices move — is the mechanical part; the judgement is deciding the proportions in the first place, which depends on the time available and the losses that can actually be sat through.",
  },
  {
    id: "market-order-book", term: "How a trade actually happens",
    aliases: ["order book", "how trades work", "matching engine", "settlement", "t+1", "clearing"],
    explanation: "Exchanges match buy and sell orders in a central order book by price and then by time. A trade needs a counterparty at your price, which is why liquidity and the spread decide the real cost of transacting. After matching comes clearing and settlement, when the shares and the money actually change hands — the next business day in India and the United States.",
  },
  {
    id: "earnings-report", term: "Earnings reports",
    aliases: ["earnings report", "earnings", "quarterly results", "results season", "guidance", "earnings call"],
    explanation: "Listed companies report results on a fixed cycle — quarterly in India and the United States — covering revenue, profit, margins and usually cash flow, often with management's guidance for what comes next. Guidance frequently moves the price more than the reported quarter, because the price reflects the future rather than the period just closed.",
  },
  {
    id: "bull-bear-market", term: "Bull and bear markets",
    aliases: ["bull market", "bear market", "correction", "market crash", "drawdown market"],
    explanation: "A bull market is a sustained rise, a bear market conventionally a fall of 20% or more from a peak, and a correction a fall of around 10%. The labels are descriptive and only obvious afterwards; they carry no information about what happens next. Their practical use is as a reminder that both are ordinary features of a long series, not aberrations.",
  },
  {
    id: "exchanges", term: "Stock exchanges",
    aliases: ["stock exchange", "nse", "bse", "nasdaq", "nyse", "sensex", "nifty"],
    explanation: "An exchange is the venue where listed securities trade, each with its own hours, currency, settlement and listing rules. NSE and BSE are India's main exchanges, quoted in rupees; NASDAQ and NYSE are the largest US venues, quoted in dollars. Indices such as NIFTY 50 or the S&P 500 summarise a selection of a market's listings.",
    inThesis: "each watched security keeps its own exchange, currency and clock, and values are never converted or combined across markets.",
  },
];

/** Corporate boilerplate that must never be treated as a company's identity. */
const MAX_CONCEPTS = 2;

type Match = { concept: FinanceConcept; at: number; length: number };

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Finds the concepts a question is about, most specific first.
 *
 * Longer aliases win: "enterprise value" must not be answered as "value", and
 * "relative volume" must not collapse to "volume". At most two concepts come
 * back, which is what a comparison question ("difference between X and Y")
 * needs and more than any single question deserves.
 */
export function findConcepts(question: string): FinanceConcept[] {
  const haystack = ` ${question.toLowerCase()} `;
  const matches: Match[] = [];
  for (const concept of FINANCE_CONCEPTS) {
    for (const alias of [concept.term, ...concept.aliases]) {
      const pattern = new RegExp(`(?<![\\w-])${escape(alias.toLowerCase())}(?![\\w-])`, "g");
      for (const found of haystack.matchAll(pattern)) {
        matches.push({ concept, at: found.index, length: alias.length });
      }
    }
  }
  matches.sort((a, b) => b.length - a.length || a.at - b.at);
  const taken: Match[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    // A longer alias already covering this span wins; "value" inside
    // "enterprise value" is the same words, not a second concept.
    if (seen.has(match.concept.id)) continue;
    if (taken.some((other) => match.at < other.at + other.length && other.at < match.at + match.length)) continue;
    seen.add(match.concept.id);
    taken.push(match);
  }
  return taken.sort((a, b) => a.at - b.at).slice(0, MAX_CONCEPTS).map((match) => match.concept);
}

/** The educational answer, and the product's own definition where it has one. */
export function explainConcepts(concepts: FinanceConcept[]): string | null {
  if (concepts.length === 0) return null;
  const say = (concept: FinanceConcept) =>
    `${concept.explanation}${concept.inThesis ? ` In THESIS, ${concept.inThesis}` : ""}`;
  if (concepts.length === 1) return say(concepts[0]);
  return concepts.map((concept) => `${concept.term} — ${say(concept)}`).join("\n\n");
}

/** A few real terms to offer when a question matched nothing. Never exhaustive. */
export function sampleTerms(count = 6): string[] {
  return FINANCE_CONCEPTS.slice(0, count).map((concept) => concept.term.toLowerCase());
}

/** The entries behind a set of ids, in the order given. */
export function conceptsById(ids: string[]): FinanceConcept[] {
  return ids.flatMap((id) => {
    const found = FINANCE_CONCEPTS.find((concept) => concept.id === id);
    return found ? [found] : [];
  });
}

/**
 * "How does THESIS calculate it?" — the same concept, as this product implements it.
 *
 * Returns null where THESIS does not compute the thing, which is the honest
 * answer for a term it merely explains. Enterprise value is a real concept this
 * engine has no opinion about, and saying so beats inventing an implementation.
 */
export function implementationOf(concepts: FinanceConcept[]): string | null {
  const implemented = concepts.filter((concept) => concept.inThesis);
  if (implemented.length === 0) {
    if (concepts.length === 0) return null;
    const names = concepts.map((concept) => concept.term.toLowerCase());
    return `THESIS does not compute ${names.join(" or ")} anywhere in the product, so there is no implementation of it to describe. It measures price movement against a security's own realized volatility, volume against its own median, and a residual against its own market index — ask about any of those and I can be specific.`;
  }
  return implemented.map((concept) => `${concept.term}: in THESIS, ${concept.inThesis}`).join("\n\n");
}
