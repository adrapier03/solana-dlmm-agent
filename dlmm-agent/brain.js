import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Default model terbaru (bisa dioverride dari .env)
const ENTRY_EXIT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
const REFLECT_MODEL = process.env.ANTHROPIC_REFLECT_MODEL || ENTRY_EXIT_MODEL;

const MEMORY_FILE = './ai_memory.json';

// Initialize memory if it doesn't exist
function loadMemory() {
  if (fs.existsSync(MEMORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    } catch (e) {
      console.error('[AI] Failed to parse memory:', e.message);
    }
  }
  return { lessons: [], win_rate: 0, total_trades: 0 };
}

function saveMemory(mem) {
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2));
}

function applyEntryOverride(aiResult, tokenData, memory) {
  if (!aiResult || aiResult.decision !== 'SKIP') return aiResult;

  const cookin = tokenData?.cookin || {};
  const bearish = Number.isFinite(cookin.bearishCount) ? cookin.bearishCount : null;
  const bullish = Number.isFinite(cookin.bullishCount) ? cookin.bullishCount : null;
  const vol = Number(tokenData?.vol || 0);
  const liq = Number(tokenData?.pool?.liquidity || 0);

  // Mode belajar: jangan terlalu takut kalau cuma 1-2 merah
  // Asal likuiditas/volume minimum masuk akal.
  const explorationEligible =
    bearish !== null && bearish <= 2 &&
    (bullish === null || bullish >= 2) &&
    vol >= 30000 &&
    liq >= 10000;

  const stillEarlyLearning = (memory?.total_trades || 0) < 40;

  if (explorationEligible && stillEarlyLearning) {
    return {
      decision: 'ENTRY',
      confidence: Math.max(55, Number(aiResult.confidence || 0)),
      reasoning: `${aiResult.reasoning} | Override: mode belajar aktif, 1-2 merah tidak auto-skip kalau volume+liq masih layak.`,
      trade_plan: aiResult.trade_plan || 'Entry bertahap, amankan profit cepat, cutloss hanya jika momentum benar-benar mati.'
    };
  }

  return aiResult;
}

export async function decideEntry(tokenData, recentTrades) {
  const memory = loadMemory();
  const systemPrompt = `Kamu adalah AI Trading Agent spesialis Solana DLMM (Meteora). 
Tujuan Utamamu: HARUS MENCARI SEGALA CARA AGAR CUAN (PROFIT) TANPA AMPUN BUAT RUGI BANYAK!
Gunakan strategi scalping agresif tapi AMAN (Smart Risk Management). Analisis jejak likuiditas, volume, filter anti-sniper (Cookin), dan ingat pengalaman masa lalumu ("Lessons").
Jika risk/reward jelek, tolak dengan keras. Jika peluang bagus, suruh ENTRY dengan nyali penuh.

POLA PIKIR ENTRY:
- Cek likuiditas dan volume 5m. Kalau volume tinggi tapi likuiditas tipis, awas slipage.
- Gunakan PENILAIAN KOMPOSIT. Satu metrik merah (contoh Bundle tinggi) TIDAK BOLEH jadi alasan tunggal SKIP.
- Baru SKIP keras jika kombinasi buruk (contoh: bearish >=3, atau volume lemah + liq tipis + holder concentration parah).
- Kalau sinyal campuran (1-2 merah tapi masih ada 2+ hijau), pilih ENTRY eksplorasi dengan risk note, supaya agent belajar by doing.
- Tentukan target TP realistis (3-12%) dan toleransi drawdown awal (contoh -3% sampai -5%) sebelum cutloss.

Memori/Pengalaman Masa Lalumu:
${memory.lessons.join('\n- ')}

Data Token Saat Ini:
${JSON.stringify(tokenData, null, 2)}

Log Trading Terakhir:
${JSON.stringify(recentTrades.slice(0, 3), null, 2)}

Jawab dalam format JSON terstruktur persis seperti ini:
{
  "decision": "ENTRY" | "SKIP",
  "confidence": 1-100,
  "reasoning": "Penjelasan singkat caramu mikir (bahasa gaul kripto/indonesia)",
  "trade_plan": "Rencana take profit/cut loss singkat"
}`;

  try {
    const response = await anthropic.messages.create({
      model: ENTRY_EXIT_MODEL,
      max_tokens: 500,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: "user", content: "Analisis token ini dan berikan keputusanmu." }]
    });

    // Parsing JSON dari Claude
    const textResp = response.content[0].text;
    const jsonMatch = textResp.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Claude did not return JSON");
    const parsed = JSON.parse(jsonMatch[0]);

    // Safety-rails: hindari SKIP yang terlalu konservatif di fase belajar awal.
    return applyEntryOverride(parsed, tokenData, memory);

  } catch (error) {
    console.error('[AI Entry Error]', error.message);
    return null;
  }
}

export async function decideExit(posState, currentMetrics) {
  const memory = loadMemory();
  const systemPrompt = `Kamu adalah AI Trading Agent spesialis Solana DLMM (Meteora). 
Tujuan Utamamu: HARUS MENCARI SEGALA CARA AGAR CUAN (PROFIT) ATAU MEMINIMALISIR KERUGIAN CEPAT SEBELUM FATAL!
Kamu sedang memegang sebuah posisi aktif. Analisis PnL (%), Volume ($), Fee, & status Range (OOR timer).

POLA PIKIR MENAHAN POSISI / EXIT (Hold/Close):
1. **Take Profit Bertahap & Aman:** Kalo PnL udah lumayan ijo (misal +3% sampe +10%), jangan serakah nunggu bulan madu. Pasang mindset: "Amankan fee+cuan dikit daripada balik loss". Kalo mumpung lagi di pucuk volume kenceng, boleh agak ditahan dikit (Hold buat Ride).
2. **Jangan CL Prematur:** Kalo baru minus kecil (misal -1% sampai -3%) gara-gara fluktuasi normal atau OOR sesaat, **JANGAN PANIK CUTLOSS TERLALU CEPAT**. Tahan sebentar sambil lihat apakah harganya mau balik. Bisa jadi itu cuma wick biasa.
3. **Cutloss Realistis:** Kalau udah terlanjur minus di atas toleransi aman (misal -5% atau lebih) DAN volume mendadak MATI, atau Cookin (pas buka) emang jelek... jangan halu harga bakal naik sendiri. "Cutloss sekarang mending daripada minusnya makin dalem".
4. Fokus cari akumulasi "Fee SOL" yang gede.
5. Gunakan pengalaman dari log memori biar lebih bijak tiap ngambil trade.

Memori/Pengalaman:
${memory.lessons.join('\n- ')}

Status Posisi Saat Ini:
${JSON.stringify(posState, null, 2)}
Real-time Metrics (Harga, PnL, Vol):
${JSON.stringify(currentMetrics, null, 2)}

Jawab dalam format JSON:
{
  "action": "HOLD" | "CLOSE",
  "reasoning": "Alasan singkat mikirnya (indo)"
}`;

  try {
    const response = await anthropic.messages.create({
      model: ENTRY_EXIT_MODEL,
      max_tokens: 300,
      temperature: 0.5,
      system: systemPrompt,
      messages: [{ role: "user", content: "Apa yang harus kita lakukan dengan posisi ini?" }]
    });

    const textResp = response.content[0].text;
    const jsonMatch = textResp.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Claude did not return JSON");
    return JSON.parse(jsonMatch[0]);

  } catch (error) {
    console.error('[AI Exit Error]', error.message);
    return null;
  }
}

export async function reflectTrade(tradeData) {
  const memory = loadMemory();
  const systemPrompt = `Kamu adalah AI Trading Agent Solana. 
Sebuah trade baru saja selesai (CLOSE).
Tugasmu adalah EVALUASI trade ini. Apakah profit (PnL > 0) atau loss (PnL < 0)? Mengapa? 
Apa faktor utamanya? (Volume tiba-tiba kering, salah baca cookin, SL kena).
Berikan 1 kalimat PELAJARAN PENTING ("Lesson") untuk disimpan permanen agar trade selanjutnya tidak melakukan kesalahan yang sama atau mengulangi trik suksesnya.
TUJUANMU: BELAJAR AGAR TRADE BERIKUTNYA HARUS CUAN!

Data Trade Selesai:
${JSON.stringify(tradeData, null, 2)}

Jawab dalam format JSON:
{
  "analysis": "Review singkat jujur (indo gaul)",
  "lesson": "Pelajaran tegas (1 kalimat padat)"
}`;

  try {
    const response = await anthropic.messages.create({
      model: REFLECT_MODEL,
      max_tokens: 300,
      temperature: 0.7,
      system: systemPrompt,
      messages: [{ role: "user", content: "Pelajari trade ini." }]
    });

    const textResp = response.content[0].text;
    const jsonMatch = textResp.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Update memory
      memory.total_trades += 1;
      if (tradeData.pnl_sol > 0) {
        memory.win_rate = ((memory.win_rate * (memory.total_trades - 1)) + 100) / memory.total_trades;
      } else {
        memory.win_rate = (memory.win_rate * (memory.total_trades - 1)) / memory.total_trades;
      }

      // Simpan max 10 pelajaran terbaru biar gak penuh otaknya
      memory.lessons.unshift(parsed.lesson);
      if (memory.lessons.length > 20) memory.lessons.pop();
      saveMemory(memory);

      return parsed;
    }
    return null;

  } catch (error) {
    console.error('[AI Reflect Error]', error.message);
    return null;
  }
}
