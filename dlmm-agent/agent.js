import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

import axios from 'axios';
import { sendTelegram } from './telegram.js';
import { decideEntry, decideExit, reflectTrade } from './brain.js';
import { scanTokens } from './scanner.js';
import { openPosition, monitorPosition, claimFees, closePosition, swapTokenToSol, fetchJupiterPriceUsd, scanOrphanPositions, connection, wallet } from './meteora.js';
import { scrapeCookinToken, passCookinFilter, formatCookinSummary } from './cookin-scraper.js';

const STATE_FILE = './state.json';
const LOG_FILE = './trade_log.json';
const POOLS_FILE = './known_pools.json'; // track semua pool yang pernah dipakai
const PID_FILE = './agent.pid';

const STOP_LOSS_PCT = parseFloat(process.env.STOP_LOSS_PCT || '20');
const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT || '10');
const FEE_CLAIM_THRESHOLD_SOL = parseFloat(process.env.FEE_CLAIM_THRESHOLD_SOL || '0.03');
const CYCLE_INTERVAL_SEC = parseInt(process.env.CYCLE_INTERVAL_SEC || '300');
const AUTO_SWAP = process.env.AUTO_SWAP === 'true';
const BUDGET_SOL = parseFloat(process.env.BUDGET_SOL || '0.5');
const OOR_ABOVE_LIMIT_MIN = parseFloat(process.env.OOR_ABOVE_LIMIT_MIN || '60');
const OOR_BELOW_LIMIT_MIN = parseFloat(process.env.OOR_BELOW_LIMIT_MIN || '20');
const VOL_DRY_THRESHOLD_USD = parseFloat(process.env.VOL_DRY_THRESHOLD_USD || '20000');
const VOL_DRY_CYCLES = parseInt(process.env.VOL_DRY_CYCLES || '3');

let cycleCount = 0;

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { activePosition: null };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { activePosition: null }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function appendLog(entry) {
  let log = [];
  if (fs.existsSync(LOG_FILE)) {
    try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch {}
  }
  log.push({ timestamp: new Date().toISOString(), ...entry });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function loadKnownPools() {
  if (!fs.existsSync(POOLS_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(POOLS_FILE, 'utf8')); } catch { return []; }
}

function addKnownPool(poolAddress) {
  const pools = loadKnownPools();
  if (!pools.includes(poolAddress)) {
    pools.push(poolAddress);
    fs.writeFileSync(POOLS_FILE, JSON.stringify(pools, null, 2));
  }
}

function fmtSol(n) { return typeof n === 'number' ? n.toFixed(4) : '0.0000'; }
function fmtPct(n) { return (n >= 0 ? '+' : '') + n.toFixed(2) + '%'; }
function fmtUsd(n) { return '$' + (n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fmtPrice(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 'N/A';
  const a = Math.abs(n);
  if (a < 0.000001) return n.toFixed(12);
  if (a < 0.001) return n.toFixed(10);
  return n.toFixed(8);
}

function isAgentProcess(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ');
    return cmdline.includes('node agent.js');
  } catch {
    return false;
  }
}

function ensureSingleInstance() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (Number.isFinite(oldPid) && oldPid > 1 && oldPid !== process.pid && isAgentProcess(oldPid)) {
        console.log(`[Guard] Found old agent PID ${oldPid}, stopping it...`);
        try { process.kill(oldPid, 'SIGTERM'); } catch {}
      }
    }
  } catch {}

  fs.writeFileSync(PID_FILE, String(process.pid));

  const cleanup = () => {
    try {
      const pidInFile = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      if (pidInFile === process.pid) fs.unlinkSync(PID_FILE);
    } catch {}
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
}

// ─── VOLUME CHECK ─────────────────────────────────────────────
// ─── VOLUME FETCH ────────────────────────────────────────────────
async function fetchVol5m(tokenMint) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenMint}`;
    const res = await axios.get(url, { timeout: 8000 });
    const pairs = res.data?.pairs || [];
    
    if (pairs.length === 0) return 0; // Token beneran mati/gak ada pair aktif

    // Totalkan volume dari semua pair yang ada untuk token ini (Raydium, Meteora, dll)
    let totalVol5m = 0;
    for (const p of pairs) {
      if (p.chainId === 'solana' && p.volume && typeof p.volume.m5 === 'number') {
        totalVol5m += p.volume.m5;
      }
    }

    return totalVol5m;
  } catch (e) {
    if (e.response && e.response.status === 429) {
      console.error('[VolCheck] Rate limit 429 hit');
      return null; // Asli error limit
    }
    console.error('[VolCheck] Fetch error:', e.message);
    return null;
  }
}

// ─── METEORA PORTFOLIO DATAPI (samakan angka dengan UI Meteora) ─────────
async function fetchMeteoraPortfolioPool(userAddress, poolAddress, positionKey) {
  try {
    const { data } = await axios.get('https://dlmm.datapi.meteora.ag/portfolio/open', {
      params: { user: userAddress, page: 1, page_size: 50 },
      timeout: 10000,
    });

    const pools = Array.isArray(data?.pools) ? data.pools : [];
    const pool = pools.find((p) => {
      if (p.poolAddress !== poolAddress) return false;
      if (!positionKey) return true;
      const list = Array.isArray(p.listPositions) ? p.listPositions : [];
      return list.includes(positionKey);
    });

    if (!pool) return null;

    const pnlUsd = parseFloat(pool.pnl);
    const pnlSol = parseFloat(pool.pnlSol);
    const pnlPct = parseFloat(pool.pnlPctChange);
    const unclaimedFeesSol = parseFloat(pool.unclaimedFeesSol);
    const poolPrice = parseFloat(pool.poolPrice);

    return {
      pnlUsd: Number.isFinite(pnlUsd) ? pnlUsd : null,
      pnlSol: Number.isFinite(pnlSol) ? pnlSol : null,
      pnlPct: Number.isFinite(pnlPct) ? pnlPct : null,
      unclaimedFeesSol: Number.isFinite(unclaimedFeesSol) ? unclaimedFeesSol : null,
      poolPrice: Number.isFinite(poolPrice) ? poolPrice : null,
    };
  } catch (e) {
    console.error('[MeteoraDatapi] Fetch error:', e.message);
    return null;
  }
}

function getOORDirection(activeBinId, minBinId, maxBinId) {
  if (activeBinId > maxBinId) return 'ABOVE';
  if (activeBinId < minBinId) return 'BELOW';
  return 'IN';
}

// ─── ORPHAN CHECK ────────────────────────────────────────────
async function checkOrphanPositions(state) {
  if (state.activePosition) return; // ada posisi yang ke-track, skip

  const knownPools = loadKnownPools();
  if (knownPools.length === 0) return;

  console.log('[Orphan] Checking for untracked positions...');
  const orphans = await scanOrphanPositions(knownPools);

  if (orphans.length === 0) return;

  console.log(`[Orphan] Found ${orphans.length} untracked position(s)!`);
  for (const o of orphans) {
    console.log(`  Pool: ${o.poolAddress} | Pos: ${o.positionKey}`);
    await sendTelegram(
      `⚠️ <b>Orphan Position Detected!</b>\n` +
      `Pool: <code>${o.poolAddress.slice(0, 20)}...</code>\n` +
      `Position: <code>${o.positionKey.slice(0, 20)}...</code>\n` +
      `X: ${o.totalX} | Y: ${o.totalY}\n` +
      `Closing automatically...`
    );

    // Close orphan position
    try {
      const fakeState = {
        positionKey: o.positionKey,
        poolAddress: o.poolAddress,
        minBinId: o.lowerBinId,
        maxBinId: o.upperBinId,
        mint: null,
        symbol: 'ORPHAN',
        budgetSol: BUDGET_SOL,
        openedAt: Date.now(),
      };
      await closePosition(fakeState);
      await sendTelegram(`✅ Orphan position closed successfully.`);
    } catch (e) {
      await sendTelegram(`❌ Failed to close orphan: ${e.message}`);
    }
  }
}

async function runCycle() {
  cycleCount++;
  const state = loadState();
  console.log(`\n[Cycle #${cycleCount}] ${new Date().toISOString()}`);

  // Check for orphan positions every 3 cycles
  if (cycleCount % 3 === 0) {
    try { await checkOrphanPositions(state); } catch (e) {
      console.error('[Orphan] Check error:', e.message);
    }
  }

  // ─── MONITOR MODE ───────────────────────────────────────────
  if (state.activePosition) {
    console.log('[Mode] MONITOR —', state.activePosition.symbol);
    let data;
    try {
      data = await monitorPosition(state.activePosition);
    } catch (e) {
      console.error('[Monitor] Error:', e.message);
      return;
    }

    if (data.error === 'position_not_found') {
      console.log('[Monitor] Position not found on-chain, clearing state.');
      saveState({ activePosition: null });
      return;
    }

    const { inRange, pnlSol, pnlPct, totalFeeSol, feeXRaw, feeYRaw, currentPrice, activeBinId, solInPos, tokenInPos, feeSol, feeToken, tokenDecimals, dlmm, pos } = data;
    const pos_state = state.activePosition;

    // Nilai default dari monitor on-chain
    let estPnlSol = pnlSol;
    let estPnlPct = pnlPct;
    let estPnlUsd = null;
    let displayFeeSol = totalFeeSol;
    let displayPrice = currentPrice;

    // Prioritaskan angka dari Meteora datapi (sama dengan UI app.meteora.ag)
    const mData = await fetchMeteoraPortfolioPool(
      wallet.publicKey.toBase58(),
      pos_state.poolAddress,
      pos_state.positionKey
    );

    if (mData) {
      if (mData.pnlSol !== null) estPnlSol = mData.pnlSol;
      if (mData.pnlPct !== null) estPnlPct = mData.pnlPct;
      if (mData.pnlUsd !== null) estPnlUsd = mData.pnlUsd;
      if (mData.unclaimedFeesSol !== null) displayFeeSol = mData.unclaimedFeesSol;
      if (mData.poolPrice !== null) displayPrice = mData.poolPrice;

      console.log(
        `  [EstPnL] Meteora datapi: ${fmtPct(estPnlPct)} ` +
        `${estPnlUsd !== null ? `(~$${estPnlUsd.toFixed(2)})` : ''} | ` +
        `Fee: ${fmtSol(displayFeeSol)} SOL | Price: ${fmtPrice(displayPrice)}`
      );
    } else {
      // fallback: on-chain + konversi USD dari SOL price
      try {
        const solPriceUsd = await fetchJupiterPriceUsd('So11111111111111111111111111111111111111112');
        if (solPriceUsd && solPriceUsd > 0) {
          estPnlUsd = estPnlSol * solPriceUsd;
          console.log(`  [EstPnL] Fallback on-chain: ${fmtPct(estPnlPct)} (~$${estPnlUsd.toFixed(2)}) | SOL=$${solPriceUsd.toFixed(2)}`);
        } else {
          console.log(`  [EstPnL] Fallback on-chain: ${fmtPct(estPnlPct)} (USD unavailable)`);
        }
      } catch (e) {
        console.error('[EstPnL] SOL price fetch error:', e.message);
      }
    }

    // ── VOLUME HEALTH CHECK
    const vol5m = await fetchVol5m(pos_state.mint);
    console.log(`  Vol5m: ${vol5m !== null ? fmtUsd(vol5m) : 'N/A'} (threshold: ${fmtUsd(VOL_DRY_THRESHOLD_USD)})`);

    // ── OLD VOLUME HEALTH CHECK DIMATIKAN KARENA ADA AI
    // Tapi data volume tetap kita butuhkan buat AI
    if (vol5m === null) {
      console.log(`  [VolDry] API Fetch Error - Volume check skipped this cycle. Menganggap volume aman.`);
    }

    const oorDir = getOORDirection(activeBinId, pos_state.minBinId, pos_state.maxBinId);
    
    // Track OOR untuk ngetok timer waktu
    if (!inRange) {
      if (!pos_state.outOfRangeSince) {
        pos_state.outOfRangeSince = Date.now();
        pos_state.oorDirection = oorDir;
        saveState(state);
      }
    } else {
      pos_state.outOfRangeSince = null;
      pos_state.oorDirection = null;
      saveState(state);
    }

    const outOfRangeMinutes = pos_state.outOfRangeSince
      ? (Date.now() - pos_state.outOfRangeSince) / 60000 : 0;

    console.log(`  PnL: ${fmtPct(estPnlPct)} | Fee: ${fmtSol(displayFeeSol)} SOL | InRange: ${inRange} | OOR: ${outOfRangeMinutes.toFixed(1)}min (${oorDir})`);

    // ── AI EXIT DECISION (CLAUDE) ──
    const posMetrics = {
      pnlPct: estPnlPct,
      pnlUsd: estPnlUsd,
      unclaimedFeeSol: displayFeeSol,
      vol5mUsd: vol5m,
      inRange,
      outOfRangeMinutes: outOfRangeMinutes.toFixed(1),
      oorDirection: oorDir,
      poolPrice: displayPrice
    };

    console.log(`🧠 AI sedang menganalisa posisi ${pos_state.symbol}...`);
    const aiDecision = await decideExit(pos_state, posMetrics);

    if (aiDecision && aiDecision.action === 'CLOSE') {
      console.log(`[Action - AI] CLOSE triggered! Alasan: ${aiDecision.reasoning}`);
      await sendTelegram(
        `🤖 <b>AI DECISION: CLOSE POSITION</b>\n` +
        `Token: <b>${pos_state.symbol}</b>\n` +
        `PnL Terakhir: ${fmtPct(estPnlPct)}\n` +
        `Alasan Claude:\n<i>"${aiDecision.reasoning}"</i>\n` +
        `Mengeksekusi cutloss/take-profit sekarang...`
      );
      await handleClose(state, pos_state, 'AI_CLOSE', estPnlSol, estPnlPct, displayFeeSol);
      return;
    }

    // ── STATUS update setiap cycle
    {
      const pnlText = estPnlUsd !== null
        ? `${fmtPct(estPnlPct)} (~$${estPnlUsd.toFixed(2)})`
        : fmtPct(estPnlPct);
      await sendTelegram(
        `📊 <b>Position Update</b>\n` +
        `Token: <b>${pos_state.symbol}</b>\n` +
        `PnL: <b>${pnlText}</b>\n` +
        `Fee: ${fmtSol(displayFeeSol)} SOL\n` +
        `Price: ${fmtPrice(displayPrice)}\n` +
        `Status: ${inRange ? '✅ In Range' : `⚠️ OOR ${oorDir} (${outOfRangeMinutes.toFixed(0)}min)`}\n` +
        (aiDecision ? `\n🧠 <b>AI Says:</b> <i>"${aiDecision.reasoning}"</i>` : '')
      );
    }

    console.log(`[Status] Healthy. PnL: ${fmtPct(estPnlPct)}`);
    return;
  }

  // ─── SCAN MODE ──────────────────────────────────────────────
  console.log('[Mode] SCAN — looking for token...');

  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSol = balance / 1e9;
  if (balanceSol < BUDGET_SOL + 0.05) {
    console.log(`[Scan] Insufficient balance: ${fmtSol(balanceSol)} SOL`);
    await sendTelegram(`⚠️ <b>Balance tidak cukup!</b>\nBalance: ${fmtSol(balanceSol)} SOL\nButuh: ${BUDGET_SOL + 0.05} SOL`);
    return;
  }

  let scanResult;
  try {
    scanResult = await scanTokens();
  } catch (e) {
    console.error('[Scan] Error:', e.message);
    return;
  }

  const { scanned, scannedTokens = [], passed, rejected = {} } = scanResult;
  console.log(`[Scan] Scanned: ${scanned} | Passed: ${passed.length}`);

  if (passed.length === 0) {
    const scannedList = scannedTokens.length
      ? scannedTokens.map((t) => `• ${t}`).join('\n')
      : '• (tidak ada data token)';

    const statusLine = scanned === 0
      ? 'Status: feed GMGN kosong / rate-limit, AI standby.'
      : `Status: belum ada pool Meteora yang tradable (No pool: ${rejected.no_pool || 0}), AI belum bisa eksekusi.`;

    await sendTelegram(
      `🧠 <b>AI Scan #${cycleCount}</b>\n` +
      `Scanned: ${scanned} tokens | Kandidat tradable: 0\n\n` +
      `<b>Token terpantau:</b>\n${scannedList}\n\n` +
      `${statusLine}\n` +
      `AI menunggu kandidat yang bisa dieksekusi on-chain.`
    );
    return;
  }

  const best = passed.sort((a, b) => b.vol - a.vol)[0];
  console.log(`[Scan] Best: ${best.symbol} | MC: $${best.mc.toLocaleString()} | Vol: $${(best.vol || 0).toLocaleString()}`);

  // ── AI ENTRY DECISION (CLAUDE) ──
  console.log(`🧠 AI mempertimbangkan entry ${best.symbol}...`);
  // Load 3 trades terakhir untuk dipelajari
  let recentTrades = [];
  try {
    const rawLogs = fs.readFileSync(LOG_FILE, 'utf8');
    const allLogs = JSON.parse(rawLogs);
    recentTrades = allLogs.filter(t => t.action === 'CLOSE').reverse().slice(0, 3);
  } catch (e) {
    // abaikan jika log belum ada
  }

  const aiEntryDecision = await decideEntry(best, recentTrades);
  if (!aiEntryDecision) {
    console.log('[AI Entry] Gagal mendapat respon dari Claude. Skip cycle ini untuk mitigasi.');
    return;
  }

  if (aiEntryDecision.decision === 'SKIP') {
    await sendTelegram(
      `🤖 <b>AI DECISION: SKIP TOKEN</b>\n` +
      `Token: <b>${best.symbol}</b> (lolos filter dasar)\n` +
      `Alasan Claude: <i>"${aiEntryDecision.reasoning}"</i>\n` +
      `Menunggu koin yang resikonya lebih masuk akal...`
    );
    return; // AI bilang skip, jangan dibeli.
  }

  await sendTelegram(
    `🤖 <b>AI DECISION: ENTRY APPROVED!</b>\n` +
    `Token: <b>${best.symbol}</b>\n` +
    `Confidence: ${aiEntryDecision.confidence}%\n` +
    `Trade Plan: <i>"${aiEntryDecision.trade_plan}"</i>\n` +
    `Memproses transaksi on-chain...`
  );

  console.log('[Action] Opening position...');
  let posData;
  try {
    // Pass callback so state saved immediately after layer 1
    best._onPositionCreated = (data) => {
      const state = loadState();
      state.activePosition = {
        ...data,
        walletBalanceBeforeOpenSol: balanceSol,
      };
      saveState(state);
      addKnownPool(data.poolAddress);
      console.log('[State] Saved after layer 1 ✅');
    };

    posData = await openPosition(best);
  } catch (e) {
    console.error('[Open] Error:', e.message);
    await sendTelegram(`❌ <b>Gagal buka posisi!</b>\nToken: ${best.symbol}\nError: ${e.message}`);
    return;
  }

  // Update state with final data (including txHash2)
  const finalState = loadState();
  if (finalState.activePosition) {
    finalState.activePosition.txHash2 = posData.txHash2;
    finalState.activePosition.walletBalanceBeforeOpenSol = balanceSol;
    saveState(finalState);
  }

  appendLog({
    action: 'OPEN',
    ...posData,
    walletBalanceBeforeOpenSol: balanceSol,
    mc: best.mc,
    vol: best.vol,
  });

  await sendTelegram(
    `🎯 <b>DLMM Position Opened!</b>\n` +
    `Token: <b>${posData.symbol}</b>\n` +
    `Pool: <code>${posData.poolAddress.slice(0, 20)}...</code>\n` +
    `Entry price: <b>${fmtPrice(posData.entryPrice)}</b>\n` +
    `Range: Bin ${posData.minBinId} → ${posData.maxBinId} (${Math.abs(posData.maxBinId - posData.minBinId)} bins)\n` +
    `Modal: <b>${posData.budgetSol} SOL</b>\n` +
    `Layer 1 (70% BidAsk): <a href="https://solscan.io/tx/${posData.txHash}">TX1</a>\n` +
    (posData.txHash2 ? `Layer 2 (30% Spot): <a href="https://solscan.io/tx/${posData.txHash2}">TX2</a>` : `Layer 2: skipped`) +
    (best.cookin ? `\n${formatCookinSummary(best.cookin)}` : '')
  );
}

async function handleClose(state, pos_state, reason, pnlSol, pnlPct, totalFeeSol) {
  const duration = Math.floor((Date.now() - pos_state.openedAt) / 60000);

  const baselineSol = Number.isFinite(pos_state.walletBalanceBeforeOpenSol)
    ? pos_state.walletBalanceBeforeOpenSol
    : ((await connection.getBalance(wallet.publicKey)) / 1e9);

  try {
    await closePosition(pos_state);
  } catch (e) {
    console.error('[Close] Error:', e.message);
    await sendTelegram(`❌ <b>Gagal close!</b>\nError: ${e.message}\nClose manual ya!`);
    return;
  }

  // Tunggu chain settle dulu
  await new Promise(r => setTimeout(r, 5000));

  let swapResult = null;
  if (AUTO_SWAP && pos_state.mint) {
    console.log('[Swap] Auto-swap token → SOL via Jupiter Ultra...');
    swapResult = await swapTokenToSol(pos_state.mint);
    if (swapResult) {
      console.log(`[Swap] Got ${swapResult.outSol.toFixed(6)} SOL`);
      // Tunggu swap settle
      await new Promise(r => setTimeout(r, 3000));
    } else {
      console.log('[Swap] Swap gagal atau tidak ada token — skip');
    }
  }

  // Ambil balance SETELAH swap selesai → realized PnL akurat
  const afterCloseLamports = await connection.getBalance(wallet.publicKey);
  const afterCloseSol = afterCloseLamports / 1e9;

  const realizedPnlSol = afterCloseSol - baselineSol;
  const realizedPnlPct = (pos_state.budgetSol || BUDGET_SOL) > 0
    ? (realizedPnlSol / (pos_state.budgetSol || BUDGET_SOL)) * 100
    : 0;

  const tradeData = {
    action: 'CLOSE', reason,
    symbol: pos_state.symbol, mint: pos_state.mint,
    pnl_sol: realizedPnlSol, pnl_pct: realizedPnlPct,
    est_pnl_sol: pnlSol, est_pnl_pct: pnlPct,
    fee_sol: totalFeeSol, duration_min: duration,
    oor_direction: pos_state.oorDirection || null,
    balance_before_open_sol: baselineSol,
    balance_after_close_sol: afterCloseSol,
    swap_result: swapResult,
  };
  appendLog(tradeData);

  state.activePosition = null;
  saveState(state);

  // ── AI REFLECT/LEARN (CLAUDE) sesudah posisi close ──
  console.log(`🧠 AI belajar dari trade ${pos_state.symbol}...`);
  const aiReflect = await reflectTrade(tradeData);

  const emoji = {
    AI_CLOSE: '🧠'
  }[reason] || '⚠️';

  const label = {
    AI_CLOSE: 'AI Dynamic Exit'
  }[reason] || `Legacy: ${reason}`;

  let msg =
    `${emoji} <b>Position Closed — ${label}</b>\n` +
    `Token: <b>${pos_state.symbol}</b>\n` +
    `Durasi: ${duration} menit\n` +
    `PnL Realized: <b>${fmtPct(realizedPnlPct)} (${fmtSol(realizedPnlSol)} SOL)</b>\n` +
    `Fee (est): ${fmtSol(totalFeeSol)} SOL\n`;

  if (aiReflect) {
    msg += `\n🧠 <b>AI Post-Trade Review:</b>\n` +
           `Analisis: <i>"${aiReflect.analysis}"</i>\n` +
           `📚 <b>Lesson Learned:</b> <i>"${aiReflect.lesson}"</i>\n`;
  }

  if (swapResult) {
    msg += `\n🔄 Auto-swap: +${fmtSol(swapResult.outSol)} SOL\n`;
    msg += `<a href="https://solscan.io/tx/${swapResult.txHash}">Swap TX</a>`;
  } else if (AUTO_SWAP) {
    msg += `\n⚠️ Auto-swap gagal — swap manual di jup.ag jika ada token sisa.`;
  }

  await sendTelegram(msg);
}

// ─── MAIN ────────────────────────────────────────────────────
async function main() {
  ensureSingleInstance();
  console.log('🧠 DLMM AI Agent starting...');
  console.log(`Wallet: ${wallet.publicKey.toBase58()}`);
  console.log('Mode: FULL AI (Entry/Exit/Reflect by Claude)');
  console.log('Legacy TP/SL/OOR rule: bypassed (AI-driven).');

  // Patch dlmm bytes import
  try {
    const dlmmPath = './node_modules/@meteora-ag/dlmm/dist/index.mjs';
    let content = fs.readFileSync(dlmmPath, 'utf8');
    if (content.includes('"@coral-xyz/anchor/dist/cjs/utils/bytes"')) {
      content = content.replace(/from "@coral-xyz\/anchor\/dist\/cjs\/utils\/bytes"/g,
        'from "@coral-xyz/anchor/dist/cjs/utils/bytes/index.js"');
      fs.writeFileSync(dlmmPath, content);
      console.log('[Patch] Fixed dlmm bytes import');
    }
  } catch {}

  await sendTelegram(
    `🧠 <b>DLMM AI Agent Started!</b>\n` +
    `Wallet: <code>${wallet.publicKey.toBase58()}</code>\n` +
    `Budget: ${BUDGET_SOL} SOL | Bins: ${process.env.RANGE_BINS}\n` +
    `Mode: <b>FULL AI</b> (Claude putuskan Entry/Exit/Learning)\n` +
    `Legacy TP/SL/OOR: <b>bypassed</b>\n` +
    `Cycle: tiap ${CYCLE_INTERVAL_SEC / 60} menit\n` +
    `Orphan check: tiap 3 cycles ✅`
  );

  await runCycle();
  setInterval(runCycle, CYCLE_INTERVAL_SEC * 1000);
}

main().catch(async (e) => {
  console.error('Fatal error:', e);
  await sendTelegram(`🚨 <b>DLMM Agent CRASH!</b>\n${e.message}`);
  process.exit(1);
});
