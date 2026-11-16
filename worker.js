const { createClient } = require('@supabase/supabase-js');
const http = require('http');

const SUPABASE_URL = 'https://datusfnmcqzkutxuxwzr.supabase.co';
const SUPABASE_SERVICE_KEY = 'sb_secret_A1T0WZQdT6mDz3X4dXrNgw_4yCq9L3i';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

const SPOT_FEE_RATE = 0.001; // 0.1%
const FUTURES_TAKER_FEE = 0.0003125;
const LIQUIDATION_TAKER_FEE = 0.0005;
const LIQUIDATION_CLEARANCE_FEE = 0.01;

let isEvaluating = false;
let lastFundingCheckTime = 0;

// 1. Fetch Live Tickers (Multi-Source Fallback for US Cloud Servers like Render)
async function getLiveRates() {
  const priceMap = {};

  // Primary: Binance Global Vision / Data Endpoint (Never Geoblocked on US Servers)
  try {
    const res = await fetch('https://data-api.binance.vision/api/v3/ticker/price');
    const data = await res.json();
    if (Array.isArray(data)) {
      data.forEach(t => {
        const sym = t.symbol.toUpperCase();
        const p = parseFloat(t.price);
        if (p > 0) {
          priceMap[`SPOT_${sym}`] = p;
          priceMap[`FUT_${sym}`] = p;
        }
      });
    }
  } catch (err) {
    console.error('Binance Vision fetch error:', err.message);
  }

  // Secondary: Binance Futures Direct (If not geoblocked, overrides with exact Futures Mark/Last price)
  try {
    const futuresRes = await fetch('https://fapi.binance.com/fapi/v1/ticker/price');
    const futuresData = await futuresRes.json();
    if (Array.isArray(futuresData)) {
      futuresData.forEach(t => {
        const sym = t.symbol.toUpperCase();
        const p = parseFloat(t.price);
        if (p > 0) {
          priceMap[`FUT_${sym}`] = p;
        }
      });
    }
  } catch (e) {}

  // Tertiary Fallback: Bybit Public API (If Binance is completely unreachable)
  if (Object.keys(priceMap).length === 0) {
    try {
      const bybitRes = await fetch('https://api.bybit.com/v5/market/tickers?category=linear');
      const bybitJson = await bybitRes.json();
      if (bybitJson?.result?.list) {
        bybitJson.result.list.forEach(t => {
          const sym = t.symbol.toUpperCase();
          const p = parseFloat(t.lastPrice);
          if (p > 0) {
            priceMap[`SPOT_${sym}`] = p;
            priceMap[`FUT_${sym}`] = p;
          }
        });
      }
    } catch (err) {
      console.error('Bybit fallback fetch error:', err.message);
    }
  }

  return priceMap;
}

// 2. Process Pending Spot Limit Orders
async function processSpotOrders(rates) {
  const { data: pendingOrders, error } = await supabase
    .from('spot_orders')
    .select('*')
    .eq('status', 'PENDING');

  if (error || !pendingOrders || pendingOrders.length === 0) return;

  for (const o of pendingOrders) {
    const cleanSym = o.symbol.toUpperCase();
    const livePrice = rates[`SPOT_${cleanSym}`] || rates[`FUT_${cleanSym}`];
    if (!livePrice || livePrice <= 0) continue;

    const coin = cleanSym.replace('USDT', '');
    const isBuy = o.side.toLowerCase() === 'buy';
    const isSell = o.side.toLowerCase() === 'sell';

    const isHit = isBuy ? livePrice <= Number(o.price) : (isSell ? livePrice >= Number(o.price) : false);

    if (isHit) {
      console.log(`[SPOT MATCH] Order ID: ${o.id} | ${cleanSym} ${o.side} @ Limit: ${o.price} | Live: ${livePrice}`);

      const tradeFee = Number((Number(o.total) * SPOT_FEE_RATE).toFixed(4));

      const { data: profile } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', o.user_id)
        .maybeSingle();

      if (!profile) continue;

      const { data: holding } = await supabase
        .from('spot_holdings')
        .select('*')
        .eq('user_id', o.user_id)
        .eq('coin', coin)
        .maybeSingle();

      const prevQty = Number(holding?.quantity || 0);
      const prevCost = Number(holding?.cost_basis || 0);

      if (isBuy) {
        const newQty = Number((prevQty + Number(o.amount)).toFixed(6));
        const newCost = Number((prevCost + Number(o.total) + tradeFee).toFixed(2));

        await supabase.from('spot_holdings').upsert({
          user_id: o.user_id,
          coin: coin,
          quantity: newQty,
          cost_basis: newCost,
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id,coin' });
      } else if (isSell) {
        const netUsdt = Number((Number(o.total) - tradeFee).toFixed(2));
        const newSpotBal = Number((Number(profile.spot_balance || 0) + netUsdt).toFixed(2));

        const fractionSold = prevQty > 0 ? Math.min(1, Number(o.amount) / prevQty) : 1;
        const nextQty = Number(Math.max(0, prevQty - Number(o.amount)).toFixed(6));
        const nextCost = Number(Math.max(0, prevCost * (1 - fractionSold)).toFixed(2));

        await supabase.from('profiles').update({
          spot_balance: newSpotBal,
          updated_at: new Date().toISOString()
        }).eq('id', o.user_id);

        if (nextQty <= 0.000001) {
          await supabase.from('spot_holdings').delete().eq('user_id', o.user_id).eq('coin', coin);
        } else {
          await supabase.from('spot_holdings').upsert({
            user_id: o.user_id,
            coin: coin,
            quantity: nextQty,
            cost_basis: nextCost,
            updated_at: new Date().toISOString()
          }, { onConflict: 'user_id,coin' });
        }
      }

      await supabase.from('spot_orders').update({
        status: 'FILLED',
        updated_at: new Date().toISOString()
      }).eq('id', o.id);

      await supabase.from('trade_history').insert({
        user_id: o.user_id,
        market: 'spot',
        symbol: o.symbol,
        pair: o.symbol,
        side: o.side.toUpperCase(),
        price: livePrice,
        amount: o.amount,
        pnl: 0,
        position_pnl: 0,
        realized_pnl: 0,
        fee: tradeFee,
        created_at: new Date().toISOString()
      });
    }
  }
}

// 3. Process Futures Positions (Pending Limits, TP/SL, Liquidation)
async function processFuturesPositions(rates) {
  const { data: allPositions, error } = await supabase
    .from('open_positions')
    .select('*');

  if (error || !allPositions || allPositions.length === 0) return;

  for (const pos of allPositions) {
    const cleanSym = pos.symbol.toUpperCase();
    const livePrice = rates[`FUT_${cleanSym}`] || rates[`SPOT_${cleanSym}`];
    if (!livePrice || livePrice <= 0) continue;

    const isLong = pos.type === 'LONG';
    const entryP = Number(pos.entry_price);
    const lev = Number(pos.leverage || 25);

    // A. Pending Futures Limit Order Trigger
    if (pos.status === 'PENDING') {
      const isLimitTriggered = isLong ? livePrice <= entryP : livePrice >= entryP;
      if (isLimitTriggered) {
        const calcLiq = isLong
          ? Number((entryP * (1 - 1 / lev + 0.005)).toFixed(2))
          : Number((entryP * (1 + 1 / lev - 0.005)).toFixed(2));

        console.log(`[FUTURES LIMIT TRIGGERED] ID: ${pos.id} | ${cleanSym} ${pos.type} @ ${entryP}`);
        await supabase.from('open_positions').update({
          status: 'OPEN',
          entry_price: entryP,
          liquidation_price: Math.max(0, calcLiq),
          last_funding_time: new Date().toISOString()
        }).eq('id', pos.id);
      }
      continue;
    }

    // B. Check Liquidation (Strict Exact Match with UI Formula)
    const storedLiq = Number(pos.liquidation_price || 0);
    const liqPrice = storedLiq > 0 ? storedLiq : (
      isLong
        ? entryP * (1 - 1 / lev + 0.005)
        : entryP * (1 + 1 / lev - 0.005)
    );

    const isLiquidated = isLong ? livePrice <= liqPrice : livePrice >= liqPrice;

    if (isLiquidated) {
      console.log(`[LIQUIDATION EXECUTED] ID: ${pos.id} | ${cleanSym} | Live: ${livePrice} | Liq: ${liqPrice}`);
      await supabase.from('open_positions').delete().eq('id', pos.id);

      const notional = Number(pos.size) * livePrice;
      const penaltyFee = Number((notional * (LIQUIDATION_TAKER_FEE + LIQUIDATION_CLEARANCE_FEE)).toFixed(4));
      const netLoss = -Number(Number(pos.margin).toFixed(2));

      await supabase.from('trade_history').insert({
        user_id: pos.user_id,
        market: 'futures',
        symbol: cleanSym,
        pair: cleanSym,
        side: pos.type,
        entry_price: entryP,
        close_price: livePrice,
        price: livePrice,
        amount: pos.size,
        size: pos.size,
        pnl: netLoss,
        position_pnl: netLoss,
        realized_pnl: netLoss,
        fee: penaltyFee,
        leverage: lev,
        open_time: pos.created_at || new Date().toISOString(),
        created_at: new Date().toISOString(),
        is_liquidated: true
      });
      continue;
    }

    // C. Check Take Profit & Stop Loss
    const hasTp = pos.take_profit && Number(pos.take_profit) > 0;
    const hasSl = pos.stop_loss && Number(pos.stop_loss) > 0;

    let isTpHit = false;
    let isSlHit = false;

    if (hasTp) {
      isTpHit = isLong ? livePrice >= Number(pos.take_profit) : livePrice <= Number(pos.take_profit);
    }
    if (hasSl) {
      isSlHit = isLong ? livePrice <= Number(pos.stop_loss) : livePrice >= Number(pos.stop_loss);
    }

    if (isTpHit || isSlHit) {
      console.log(`[FUTURES ${isTpHit ? 'TP' : 'SL'} HIT] ID: ${pos.id} | ${cleanSym} @ ${livePrice}`);

      await supabase.from('open_positions').delete().eq('id', pos.id);

      const priceDiff = isLong ? livePrice - entryP : entryP - livePrice;
      const rawPnl = Number((priceDiff * Number(pos.size)).toFixed(4));

      const notionalExit = Number(pos.size) * livePrice;
      const exitFee = Number((notionalExit * FUTURES_TAKER_FEE).toFixed(4));
      const fundingFee = Number(pos.accumulated_funding_fee || 0);

      const netPnl = Number((rawPnl - exitFee - fundingFee).toFixed(4));
      // ISOLATED MARGIN PROTECTION: Refund never goes below 0
      const refundToWallet = Number(Math.max(0, Number(pos.margin) + rawPnl - exitFee).toFixed(2));

      const { data: profile } = await supabase
        .from('profiles')
        .select('futures_balance')
        .eq('id', pos.user_id)
        .maybeSingle();

      if (profile) {
        const nextFutBal = Number(Math.max(0, Number(profile.futures_balance || 0) + refundToWallet).toFixed(2));
        await supabase.from('profiles').update({
          futures_balance: nextFutBal,
          updated_at: new Date().toISOString()
        }).eq('id', pos.user_id);
      }

      await supabase.from('trade_history').insert({
        user_id: pos.user_id,
        market: 'futures',
        symbol: cleanSym,
        pair: cleanSym,
        side: pos.type,
        entry_price: entryP,
        close_price: livePrice,
        price: livePrice,
        amount: pos.size,
        size: pos.size,
        pnl: netPnl,
        position_pnl: netPnl,
        realized_pnl: rawPnl,
        fee: exitFee,
        funding_fee: fundingFee,
        leverage: lev,
        open_time: pos.created_at || new Date().toISOString(),
        created_at: new Date().toISOString(),
        is_liquidated: false
      });
    }
  }
}

// 4. Automated Funding Fee Engine (Every 8 Hours)
async function processFundingFees() {
  const now = Date.now();
  if (now - lastFundingCheckTime < 10 * 60 * 1000) return;
  lastFundingCheckTime = now;

  try {
    const { data: openPos, error } = await supabase
      .from('open_positions')
      .select('*')
      .eq('status', 'OPEN');

    if (error || !openPos || openPos.length === 0) return;

    for (const pos of openPos) {
      const lastFunding = pos.last_funding_time ? new Date(pos.last_funding_time).getTime() : new Date(pos.created_at).getTime();
      const eightHoursMs = 8 * 60 * 60 * 1000;

      if (now - lastFunding >= eightHoursMs) {
        const fundingRate = 0.0001;
        const notional = Number(pos.size) * Number(pos.entry_price);
        const feeAmount = Number((notional * fundingRate).toFixed(4));
        const prevAcc = Number(pos.accumulated_funding_fee || 0);

        const newAcc = pos.type === 'LONG' ? prevAcc + feeAmount : prevAcc - feeAmount;

        await supabase.from('open_positions').update({
          accumulated_funding_fee: newAcc,
          last_funding_time: new Date().toISOString()
        }).eq('id', pos.id);

        console.log(`[FUNDING FEE APPLIED] Pos ID: ${pos.id} | Fee: ${feeAmount}`);
      }
    }
  } catch (err) {
    console.error('Funding fee processing error:', err.message);
  }
}

// Main Engine Loop (Every 2000ms)
async function startWorker() {
  console.log('--- 🚀 24/7 BACKGROUND EXECUTION WORKER STARTED ---');
  setInterval(async () => {
    if (isEvaluating) return;
    isEvaluating = true;
    try {
      const rates = await getLiveRates();
      if (Object.keys(rates).length > 0) {
        await Promise.allSettled([
          processSpotOrders(rates),
          processFuturesPositions(rates),
          processFundingFees()
        ]);
      }
    } catch (e) {
      console.error('Worker cycle loop error:', e.message);
    } finally {
      isEvaluating = false;
    }
  }, 2000);
}

startWorker();

const PORT = process.env.PORT || 10000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Trade engine is running 24/7');
}).listen(PORT, () => {
  console.log(`Port listening on ${PORT}`);
});
