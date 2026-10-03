const express = require("express");
const axios = require("axios");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const UPBIT = "https://api.upbit.com/v1";

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function upbitGet(endpoint, params = {}, retries = 3) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await axios.get(`${UPBIT}${endpoint}`, {
        params,
        timeout: 10000,
        headers: { Accept: "application/json" }
      });
      return r.data;
    } catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (![429, 500, 502, 503, 504].includes(status) || i === retries) break;
      await sleep(700 * (i + 1));
    }
  }
  throw lastErr;
}

async function getMarkets() {
  const all = await upbitGet("/market/all", { isDetails: false });
  return all.filter(x => x.market.startsWith("KRW-"));
}

async function getTickers(markets) {
  const out = [];
  // Upbit accepts comma-separated market codes. Keep batches conservative.
  for (let i = 0; i < markets.length; i += 100) {
    const batch = markets.slice(i, i + 100);
    const data = await upbitGet("/ticker", { markets: batch.join(",") });
    out.push(...data);
    if (i + 100 < markets.length) await sleep(120);
  }
  return out;
}

async function getCandles(unit, market, count = 200, to) {
  const params = { market, count: Math.min(count, 200) };
  if (to) params.to = to;
  return upbitGet(`/candles/minutes/${unit}`, params);
}

async function getPagedMinuteCandles(market, unit = 60, total = 300) {
  const all = [];
  let to;
  while (all.length < total) {
    const batch = await getCandles(unit, market, Math.min(200, total - all.length), to);
    if (!batch.length) break;
    all.push(...batch);
    const oldest = batch[batch.length - 1].candle_date_time_utc;
    to = `${oldest}Z`;
    if (batch.length < 200) break;
    await sleep(130);
  }

  const map = new Map();
  for (const c of all) map.set(c.timestamp, c);
  return [...map.values()].sort((a, b) => a.timestamp - b.timestamp).slice(-total);
}

function sma(values, period) {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    return s / period;
  });
}

function atr(candles, period = 14) {
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high_price - c.low_price;
    return Math.max(
      c.high_price - c.low_price,
      Math.abs(c.high_price - candles[i - 1].trade_price),
      Math.abs(c.low_price - candles[i - 1].trade_price)
    );
  });
  return sma(tr, period);
}

function cmf(candles, period = 20) {
  const mfv = candles.map(c => {
    const range = c.high_price - c.low_price;
    if (!range) return 0;
    const mfm = ((c.trade_price - c.low_price) - (c.high_price - c.trade_price)) / range;
    return mfm * c.candle_acc_trade_volume;
  });
  return candles.map((_, i) => {
    if (i < period - 1) return null;
    let money = 0, vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      money += mfv[j];
      vol += candles[j].candle_acc_trade_volume;
    }
    return vol ? money / vol : null;
  });
}

function swings(candles) {
  const highs = [], lows = [];
  // Confirmed 5-bar pivots; the last two bars cannot create a confirmed pivot.
  for (let i = 2; i < candles.length - 2; i++) {
    const h = candles[i].high_price;
    if (
      h > candles[i-1].high_price && h > candles[i-2].high_price &&
      h > candles[i+1].high_price && h > candles[i+2].high_price
    ) highs.push({ price: h, index: i });
    const l = candles[i].low_price;
    if (
      l < candles[i-1].low_price && l < candles[i-2].low_price &&
      l < candles[i+1].low_price && l < candles[i+2].low_price
    ) lows.push({ price: l, index: i });
  }
  return { highs, lows };
}

function structure(candles) {
  const { highs, lows } = swings(candles);
  if (highs.length < 2 || lows.length < 2) {
    return { type: "미확인", highs, lows };
  }
  const hh = highs.at(-1).price > highs.at(-2).price;
  const hl = lows.at(-1).price > lows.at(-2).price;
  const lh = highs.at(-1).price < highs.at(-2).price;
  const ll = lows.at(-1).price < lows.at(-2).price;

  if (hh && hl) return { type: "상승(HH/HL)", highs, lows };
  if (lh && ll) return { type: "하락(LH/LL)", highs, lows };
  return { type: "혼조/횡보", highs, lows };
}

function rangeInfo(candles, atrValue) {
  const recent = candles.slice(-80);
  if (recent.length < 30 || !atrValue) return { status: "미확인" };
  const hi = Math.max(...recent.map(c => c.high_price));
  const lo = Math.min(...recent.map(c => c.low_price));
  const tol = Math.max(atrValue * 0.8, hi * 0.003);
  const highTouches = recent.filter(c => Math.abs(c.high_price - hi) <= tol).length;
  const lowTouches = recent.filter(c => Math.abs(c.low_price - lo) <= tol).length;
  if (highTouches < 2 || lowTouches < 2) return { status: "미확인" };

  const price = recent.at(-1).trade_price;
  const pos = (price - lo) / (hi - lo);
  return {
    status: "확인",
    high: hi,
    low: lo,
    position: pos,
    middle50: pos >= 0.25 && pos <= 0.75,
    highTouches,
    lowTouches
  };
}

function analyze(candles, btc, eth) {
  if (candles.length < 240) return { status: "데이터 부족" };

  const closes = candles.map(c => c.trade_price);
  const s10 = sma(closes, 10);
  const s20 = sma(closes, 20);
  const s240 = sma(closes, 240);
  const a14 = atr(candles, 14);
  const c20 = cmf(candles, 20);
  const i = candles.length - 1;
  const price = closes[i];
  const v10 = s10[i], v20 = s20[i], v240 = s240[i];
  const av = a14[i], cv = c20[i];
  const st = structure(candles);
  const rg = rangeInfo(candles, av);

  const lastLow = st.lows.at(-1)?.price;
  const resist = st.highs.filter(x => x.price > price).sort((a,b) => a.price-b.price)[0]?.price;
  const invalidation = lastLow && lastLow < price ? lastLow : null;
  const target = resist || null;

  let rr = null;
  if (invalidation && target && target > price) {
    const risk = price - invalidation;
    const reward = target - price;
    if (risk > 0) rr = reward / risk;
  }

  const g1 = rr == null ? "미확인" : rr >= 2 ? "PASS" : "FAIL";
  const g2 = (btc && eth)
    ? ((btc.price > btc.sma240 && eth.price > eth.sma240) ? "PASS" : "WARNING")
    : "미확인";
  const g3 = cv == null ? "미확인" : cv > 0 ? "PASS" : "WARNING";

  // G4: simple, explicit recent 3-candle rejection test near a confirmed resistance.
  const last3 = candles.slice(-3);
  let g4 = "미확인";
  if (last3.length === 3 && st.highs.length) {
    const r = st.highs.at(-1).price;
    const tested = last3.some(c => c.high_price >= r * 0.998);
    const rejected = last3.at(-1).trade_price < last3.at(-1).high_price &&
                     last3.at(-1).trade_price < last3.at(-1).opening_price;
    g4 = tested && rejected ? "해당" : "PASS";
  }

  const g5 = rg.status !== "확인" ? "미확인" : (rg.middle50 ? "WARNING" : "PASS");

  const cf = {
    CF1: price < v240,
    CF2: v10 < v20,
    CF3: invalidation == null,
    CF4: target == null,
    CF5: g2 === "WARNING",
    CF6: g5 === "WARNING",
    CF7: false
  };

  const hasCF = Object.values(cf).some(Boolean);
  let grade = "C";
  if (!hasCF && g1 === "PASS" && g2 === "PASS" && g3 === "PASS" &&
      g4 === "PASS" && g5 === "PASS" && st.type === "상승(HH/HL)" && rr >= 2) {
    grade = "A";
  } else if (!hasCF && g1 === "PASS" && st.type === "상승(HH/HL)") {
    grade = "B";
  } else if (hasCF || st.type === "하락(LH/LL)") {
    grade = "D";
  }

  const finalState =
    grade === "A" ? "진입 가능" :
    grade === "B" ? "조건부" :
    "진입 금지";

  return {
    status: "확인",
    price, sma10: v10, sma20: v20, sma240: v240, atr14: av, cmf20: cv,
    structure: st.type,
    deviation20: ((price - v20) / v20) * 100,
    invalidation, target, rr,
    range: rg,
    grade, finalState,
    gStatus: { G1: g1, G2: g2, G3: g3, G4: g4, G5: g5 },
    criticalFail: cf,
    candles: candles.slice(-120).map((c, k) => ({
      time: c.timestamp,
      open: c.opening_price,
      high: c.high_price,
      low: c.low_price,
      close: c.trade_price,
      volume: c.candle_acc_trade_volume,
      sma10: s10[candles.length - 120 + k],
      sma20: s20[candles.length - 120 + k],
      sma240: s240[candles.length - 120 + k]
    }))
  };
}

async function contextAsset(market) {
  const candles = await getPagedMinuteCandles(market, 60, 300);
  const closes = candles.map(c => c.trade_price);
  const s240 = sma(closes, 240);
  return {
    price: closes.at(-1),
    sma240: s240.at(-1)
  };
}

app.get("/api/health", async (req, res) => {
  try {
    const data = await upbitGet("/market/all", { isDetails: false });
    res.json({ ok: true, markets: data.length, time: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ ok: false, error: "Upbit API 오류" });
  }
});

app.get("/api/scan", async (req, res) => {
  try {
    const minVol = Number(req.query.minVol || 30) * 100000000;
    const limit = Math.min(Math.max(Number(req.query.limit || 10), 5), 20);

    const markets = await getMarkets();
    const tickers = await getTickers(markets.map(x => x.market));
    const nameMap = new Map(markets.map(x => [x.market, x.korean_name]));

    const candidates = tickers
      .filter(t => t.acc_trade_price_24h >= minVol)
      .sort((a,b) => b.acc_trade_price_24h - a.acc_trade_price_24h)
      .slice(0, limit);

    let btc = null, eth = null;
    try {
      [btc, eth] = await Promise.all([
        contextAsset("KRW-BTC"),
        contextAsset("KRW-ETH")
      ]);
    } catch (_) {}

    const results = [];
    for (const t of candidates) {
      try {
        const candles = await getPagedMinuteCandles(t.market, 60, 300);
        const analysis = analyze(candles, btc, eth);
        results.push({
          market: t.market,
          name: nameMap.get(t.market) || t.market,
          currentPrice: t.trade_price,
          changeRate: t.signed_change_rate * 100,
          tradeValue24h: t.acc_trade_price_24h,
          ...analysis
        });
      } catch (e) {
        results.push({
          market: t.market,
          name: nameMap.get(t.market) || t.market,
          currentPrice: t.trade_price,
          changeRate: t.signed_change_rate * 100,
          tradeValue24h: t.acc_trade_price_24h,
          status: "Upbit API 오류"
        });
      }
      await sleep(120);
    }

    results.sort((a,b) => {
      const order = { "진입 가능": 0, "조건부": 1, "진입 금지": 2 };
      return (order[a.finalState] ?? 3) - (order[b.finalState] ?? 3);
    });

    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      scanned: candidates.length,
      results
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ ok: false, error: "Upbit API 오류" });
  }
});

app.listen(PORT, () => console.log(`Upbit scanner listening on ${PORT}`));
