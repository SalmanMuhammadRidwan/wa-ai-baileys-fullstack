// index.js — Full Upgrade: Smart AI NLU, CRUD Agenda, Auto-Delete Expired, Reminder (60m/30m/0m), & RBAC
require("dotenv").config();
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = require("@whiskeysockets/baileys");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const cron = require("node-cron");
const express = require("express");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const pino = require("pino");
const path = require("path");
const fs = require("fs");
const db = require("./database");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

let sock = null;
let currentQRBase64 = null;
let connectionStatus = "disconnected";
let connectedPhone = "-";

const botSentMessageIds = new Set();
const hasValidGeminiKey =
  process.env.GEMINI_API_KEY &&
  process.env.GEMINI_API_KEY !== "MASUKKAN_API_KEY_GEMINI_ANDA_DI_SINI" &&
  process.env.GEMINI_API_KEY.trim().length > 10;
const genAI = hasValidGeminiKey
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY.trim())
  : null;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DAYS_MAP = [
  "Minggu",
  "Senin",
  "Selasa",
  "Rabu",
  "Kamis",
  "Jumat",
  "Sabtu",
];

// Helper waktu lokal WIB
function getCurrentTimeInfo() {
  const now = new Date();
  const dayName = DAYS_MAP[now.getDay()];
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  return {
    now,
    dayName,
    dateStr: `${yyyy}-${mm}-${dd}`,
    timeStr: `${hh}:${min}`,
    totalMinutes: now.getHours() * 60 + now.getMinutes(),
  };
}

// Helper konversi "HH:MM" ke total menit sejak 00:00
function parseHHMMToMinutes(hhmm) {
  if (!hhmm || !hhmm.includes(":")) return null;
  const [h, m] = hhmm.split(":").map(Number);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

// Pembungkus kirim pesan anti-loop
async function safeSendMessage(jid, content, options = {}) {
  if (!sock || connectionStatus !== "connected") return null;
  const sent = await sock.sendMessage(jid, content, options);
  if (sent?.key?.id) {
    botSentMessageIds.add(sent.key.id);
    setTimeout(() => botSentMessageIds.delete(sent.key.id), 60000);
  }
  return sent;
}

// ============================================================================
// 1. CEK HAK AKSES (ADMIN ONLY ATAU PUBLIC)
// ============================================================================
function checkUserPermission(m) {
  const sessionRow = db
    .prepare(
      "SELECT access_mode FROM wa_sessions WHERE session_id = 'primary_session'",
    )
    .get();
  const mode = sessionRow?.access_mode || "admin_only";

  // Jika mode diatur ke 'public', semua orang di grup bisa tambah/edit/hapus
  if (mode === "public") return true;

  // Jika dikirim dari HP/nomor pemilik bot sendiri (fromMe), otomatis Admin
  if (m.key.fromMe) return true;

  const participantJid = m.key.participant || m.key.remoteJid;
  const participantNumber = participantJid.split("@")[0].split(":")[0];

  // Cek apakah nomor pengirim sama dengan nomor bot atau terdaftar di tabel users
  if (connectedPhone && participantNumber === connectedPhone) return true;
  const isRegisteredAdmin = db
    .prepare("SELECT id FROM users WHERE jid LIKE ?")
    .get(`%${participantNumber}%`);
  return Boolean(isRegisteredAdmin);
}

// ============================================================================
// 2. BROADCAST SATU AGENDA ATAU KESELURUHAN AGENDA KE SEMUA GRUP TERDAFTAR
// ============================================================================
async function broadcastSingleAgenda(agendaId, broadcastType = "main") {
  if (!sock || connectionStatus !== "connected") {
    return { success: false, message: "WhatsApp belum terhubung" };
  }

  const agenda = db.prepare("SELECT * FROM agendas WHERE id = ?").get(agendaId);
  if (!agenda)
    return { success: false, message: `Agenda #${agendaId} tidak ditemukan.` };

  const targets = db
    .prepare("SELECT * FROM contacts_groups WHERE is_active = 1")
    .all();
  if (targets.length === 0) {
    return {
      success: false,
      message:
        "Belum ada grup terdaftar. Ketik !daftartest di grup terlebih dahulu.",
    };
  }

  let headerTitle = "📢 *[PEMBERITAHUAN AGENDA - WAKTU TIBA]*";
  if (broadcastType === "remind_60m") {
    headerTitle = "⏳ *[PENGINGAT AGENDA - KURANG DARI 1 JAM]*";
  } else if (broadcastType === "remind_30m") {
    headerTitle = "⚠️ *[PENGINGAT AGENDA - 30 MENIT LAGI]*";
  } else if (broadcastType === "manual_single") {
    headerTitle = "📢 *[INFORMASI AGENDA KEGIATAN]*";
  }

  const formattedMessage =
    `${headerTitle}\n` +
    `📌 *Agenda (#${agenda.id}):* ${agenda.title}\n` +
    `🗓️ *Hari/Jadwal:* ${agenda.schedule_label}\n` +
    `🕒 *Waktu:* Pukul ${agenda.time_hhmm} WIB\n\n` +
    `📝 *Detail:*\n${agenda.message_body}`;

  let sentCount = 0;
  for (const target of targets) {
    try {
      await sock.sendPresenceUpdate("composing", target.jid);
      await delay(1000);
      await safeSendMessage(target.jid, { text: formattedMessage });

      db.prepare(
        `INSERT INTO broadcast_logs (agenda_id, recipient_jid, broadcast_type, status) VALUES (?, ?, ?, 'sent')`,
      ).run(agenda.id, target.jid, broadcastType);
      sentCount++;
      await delay(2500);
    } catch (err) {
      db.prepare(
        `INSERT INTO broadcast_logs (agenda_id, recipient_jid, broadcast_type, status, error_msg) VALUES (?, ?, ?, 'failed', ?)`,
      ).run(agenda.id, target.jid, broadcastType, err.message);
    }
  }

  db.prepare(
    "UPDATE agendas SET last_run = CURRENT_TIMESTAMP WHERE id = ?",
  ).run(agenda.id);
  return { success: true, sentCount, agenda };
}

// Kirim Rekap Keseluruhan Agenda Sekaligus ke Semua Grup Terdaftar
async function broadcastAllAgendasSummary() {
  if (!sock || connectionStatus !== "connected") {
    return { success: false, message: "WhatsApp belum terhubung" };
  }

  const agendas = db
    .prepare("SELECT * FROM agendas WHERE status = 'active' ORDER BY id ASC")
    .all();
  if (agendas.length === 0) {
    return { success: false, message: "Tidak ada agenda aktif saat ini." };
  }

  const targets = db
    .prepare("SELECT * FROM contacts_groups WHERE is_active = 1")
    .all();
  if (targets.length === 0) {
    return { success: false, message: "Belum ada grup terdaftar." };
  }

  let summaryText =
    `📋 *[REKAPITULASI KESELURUHAN AGENDA AKTIF]*\n` +
    `Total: *${agendas.length} Agenda Terjadwal*\n\n`;

  agendas.forEach((a, idx) => {
    const modeTag = a.auto_delete_after
      ? " _(Sekali Jalan / Auto-Hapus)_"
      : " _(Rutin)_";
    summaryText +=
      `*${idx + 1}. [ID #${a.id}] ${a.title}*${modeTag}\n` +
      `   🕒 Jadwal: ${a.schedule_label}\n` +
      `   📝 Ket: ${a.message_body}\n\n`;
  });

  summaryText += `_Dikirim otomatis ke seluruh grup terdaftar oleh WA AI Chatbot._`;

  let sentCount = 0;
  for (const target of targets) {
    try {
      await safeSendMessage(target.jid, { text: summaryText });
      db.prepare(
        `INSERT INTO broadcast_logs (agenda_id, recipient_jid, broadcast_type, status) VALUES (0, ?, 'manual_all', 'sent')`,
      ).run(target.jid);
      sentCount++;
      await delay(2500);
    } catch (err) {
      db.prepare(
        `INSERT INTO broadcast_logs (agenda_id, recipient_jid, broadcast_type, status, error_msg) VALUES (0, ?, 'manual_all', 'failed', ?)`,
      ).run(target.jid, err.message);
    }
  }

  return { success: true, sentCount, totalAgendas: agendas.length };
}

// ============================================================================
// 3. ENGINE PENJADWALAN PINTAR: PENGINGAT H-60, H-30, H-0 & AUTO-DELETE EXPIRED
// ============================================================================
function startSmartSchedulerEngine() {
  // Berjalan setiap 1 menit memeriksa seluruh agenda di database
  cron.schedule("* * * * *", async () => {
    const { dayName, dateStr, totalMinutes } = getCurrentTimeInfo();
    const agendas = db
      .prepare("SELECT * FROM agendas WHERE status = 'active'")
      .all();

    for (const agenda of agendas) {
      const isMatchingDay =
        agenda.day_name.toLowerCase() === dayName.toLowerCase() ||
        agenda.day_name.toLowerCase() === "harian" ||
        agenda.day_name.toLowerCase() === "setiap hari";

      const agendaMinutes = parseHHMMToMinutes(agenda.time_hhmm);
      if (agendaMinutes === null) continue;

      const diffMinutes = agendaMinutes - totalMinutes; // Selisih menit menuju waktu agenda

      if (isMatchingDay) {
        // 1. PENGINGAT KURANG DARI SEJAM (Antara 55 s.d. 60 menit sebelum acara)
        if (
          diffMinutes <= 60 &&
          diffMinutes >= 55 &&
          agenda.reminded_60m !== dateStr
        ) {
          console.log(
            `⏳ [REMINDER H-60m] Mengirim pengingat 1 jam untuk agenda #${agenda.id}: ${agenda.title}`,
          );
          db.prepare("UPDATE agendas SET reminded_60m = ? WHERE id = ?").run(
            dateStr,
            agenda.id,
          );
          await broadcastSingleAgenda(agenda.id, "remind_60m");
        }

        // 2. PENGINGAT 30 MENIT SEBELUM ACARA (Antara 28 s.d. 30 menit sebelum acara)
        if (
          diffMinutes <= 30 &&
          diffMinutes >= 28 &&
          agenda.reminded_30m !== dateStr
        ) {
          console.log(
            `⚠️ [REMINDER H-30m] Mengirim pengingat 30 menit untuk agenda #${agenda.id}: ${agenda.title}`,
          );
          db.prepare("UPDATE agendas SET reminded_30m = ? WHERE id = ?").run(
            dateStr,
            agenda.id,
          );
          await broadcastSingleAgenda(agenda.id, "remind_30m");
        }

        // 3. SAAT WAKTUNYA TIBA (Diff 0 atau -1 menit)
        if (
          diffMinutes <= 0 &&
          diffMinutes >= -1 &&
          agenda.reminded_0m !== dateStr
        ) {
          console.log(
            `🔔 [WAKTU TIBA H-0] Mengirim agenda utama #${agenda.id}: ${agenda.title}`,
          );
          db.prepare("UPDATE agendas SET reminded_0m = ? WHERE id = ?").run(
            dateStr,
            agenda.id,
          );
          await broadcastSingleAgenda(agenda.id, "main");
        }

        // 4. AUTO-DELETE SETELAH WAKTU TERLEWATI (Jika agenda diset auto_delete_after = 1 dan sudah lewat > 2 menit)
        if (agenda.auto_delete_after === 1 && diffMinutes < -2) {
          console.log(
            `🗑️ [AUTO-DELETE] Agenda #${agenda.id} ("${agenda.title}") otomatis dihapus karena waktunya telah terlewati.`,
          );
          db.prepare("DELETE FROM agendas WHERE id = ?").run(agenda.id);

          // Beri tahu grup bahwa agenda sekali jalan telah selesai & dihapus otomatis
          const targets = db
            .prepare("SELECT * FROM contacts_groups WHERE is_active = 1")
            .all();
          for (const t of targets) {
            await safeSendMessage(t.jid, {
              text: `🗑️ *[AUTO-CLEAN AGENDA]*\nAgenda *#${agenda.id} - ${agenda.title}* (${agenda.schedule_label}) telah melewati waktunya dan otomatis dihapus dari daftar aktif.`,
            });
          }
        }
      }
    }
  });

  console.log(
    `⏰ [SMART SCHEDULER AKTIF] Memantau pengingat H-60 menit, H-30 menit, waktu tiba (H-0), dan Auto-Delete setiap menit.`,
  );
}

// ============================================================================
// 4. MESIN HYBRID AI ASSISTANT (NLU LOKAL CERDAS + GEMINI LLM)
// ============================================================================
async function generateSmartAIResponse(senderJid, userMessage) {
  const cleanMsg = userMessage.trim();
  const lowerMsg = cleanMsg.toLowerCase();
  const { dayName, timeStr, totalMinutes } = getCurrentTimeInfo();
  const allAgendas = db
    .prepare("SELECT * FROM agendas WHERE status = 'active' ORDER BY id ASC")
    .all();

  // Simpan ke riwayat percakapan
  db.prepare(
    `INSERT INTO chat_histories (sender_jid, role, message) VALUES (?, 'user', ?)`,
  ).run(senderJid, cleanMsg);

  // ------------------------------------------------------------------------
  // LAPIS 1: DETEKSI PERINTAH / PERTANYAAN SPESIFIK SECARA INSTAN & AKURAT
  // ------------------------------------------------------------------------

  // A. Deteksi kata "menu", "imenu" (typo), "help", "bantuan", "fitur" tanpa tanda seru
  if (/^(i?menu|help|bantuan|perintah|panduan|fitur)$/i.test(lowerMsg)) {
    const reply = getFormattedMenuText();
    db.prepare(
      `INSERT INTO chat_histories (sender_jid, role, message) VALUES (?, 'model', ?)`,
    ).run(senderJid, reply);
    return reply;
  }

  // B. Deteksi pertanyaan tentang HARI TERTENTU (Contoh: "Semua agenda hari senin", "Tampilkan jadwal rabu", "hari ini", "besok")
  let requestedDays = [];
  for (const d of DAYS_MAP) {
    if (lowerMsg.includes(d.toLowerCase())) {
      requestedDays.push(d);
    }
  }
  if (lowerMsg.includes("hari ini") || lowerMsg.includes("sekarang")) {
    if (!requestedDays.includes(dayName)) requestedDays.push(dayName);
  }
  if (lowerMsg.includes("besok")) {
    const tomorrowIdx = (DAYS_MAP.indexOf(dayName) + 1) % 7;
    const tomorrowName = DAYS_MAP[tomorrowIdx];
    if (!requestedDays.includes(tomorrowName)) requestedDays.push(tomorrowName);
  }

  if (requestedDays.length > 0) {
    const filtered = allAgendas.filter((a) =>
      requestedDays.some(
        (reqDay) =>
          a.day_name.toLowerCase() === reqDay.toLowerCase() ||
          a.day_name.toLowerCase() === "harian",
      ),
    );

    let reply = "";
    const dayTitle = requestedDays.join(", ");
    if (filtered.length === 0) {
      reply = `📅 *Informasi Agenda Hari ${dayTitle}*\n\nSaat ini **tidak ada agenda** yang terjadwal untuk hari *${dayTitle}*.\n\nKetik *!tambah Judul | ${requestedDays[0]}, 09:00 | Isi Pesan* jika ingin menambahkan agenda baru.`;
    } else {
      reply = `📅 *Daftar Agenda Hari ${dayTitle}* (Ditemukan ${filtered.length} Agenda):\n\n`;
      filtered.forEach((a, i) => {
        const sifat = a.auto_delete_after
          ? "Sekali Jalan (Auto-Hapus)"
          : "Rutin Mingguan";
        reply +=
          `*${i + 1}. ${a.title}* (ID #${a.id})\n` +
          `   🕒 Waktu: Pukul *${a.time_hhmm} WIB* (${a.schedule_label})\n` +
          `   🔄 Sifat: ${sifat}\n` +
          `   📝 Detail: ${a.message_body}\n\n`;
      });
      reply += `💡 _Ingin membagikan salah satu agenda di atas sekarang? Ketik *!share <ID>* (contoh: *!share ${filtered[0].id}*)._`;
    }
    db.prepare(
      `INSERT INTO chat_histories (sender_jid, role, message) VALUES (?, 'model', ?)`,
    ).run(senderJid, reply);
    return reply;
  }

  // C. Deteksi permintaan melihat SEMUA AGENDA secara natural (Contoh: "tampilkan semua agenda", "apa saja jadwal kita", "daftar agenda")
  if (
    (lowerMsg.includes("semua") ||
      lowerMsg.includes("daftar") ||
      lowerMsg.includes("list") ||
      lowerMsg.includes("apa saja")) &&
    (lowerMsg.includes("agenda") ||
      lowerMsg.includes("jadwal") ||
      lowerMsg.includes("kegiatan"))
  ) {
    if (allAgendas.length === 0) {
      return `📭 Saat ini belum ada agenda yang terdaftar di database.`;
    }
    let reply = `📋 *Berikut Seluruh Agenda Aktif Saat Ini (${allAgendas.length} Agenda):*\n\n`;
    allAgendas.forEach((a, idx) => {
      reply += `*${idx + 1}. [ID #${a.id}] ${a.title}*\n   🕒 ${a.schedule_label}\n   📝 ${a.message_body}\n\n`;
    });
    reply += `_Anda dapat menanyakan hari spesifik seperti "Agenda hari Senin" atau mengetik *!menu* untuk perintah kelola._`;
    db.prepare(
      `INSERT INTO chat_histories (sender_jid, role, message) VALUES (?, 'model', ?)`,
    ).run(senderJid, reply);
    return reply;
  }

  // D. Deteksi pertanyaan AGENDA TERDEKAT / SELANJUTNYA
  if (
    lowerMsg.includes("terdekat") ||
    lowerMsg.includes("selanjutnya") ||
    lowerMsg.includes("berikutnya")
  ) {
    const todayAgendas = allAgendas
      .filter(
        (a) =>
          a.day_name.toLowerCase() === dayName.toLowerCase() &&
          parseHHMMToMinutes(a.time_hhmm) >= totalMinutes,
      )
      .sort(
        (a, b) =>
          parseHHMMToMinutes(a.time_hhmm) - parseHHMMToMinutes(b.time_hhmm),
      );

    if (todayAgendas.length > 0) {
      const nextA = todayAgendas[0];
      const diff = parseHHMMToMinutes(nextA.time_hhmm) - totalMinutes;
      const reply =
        `⏰ *Agenda Terdekat Hari Ini (${dayName}):*\n\n` +
        `📌 *${nextA.title}* (ID #${nextA.id})\n` +
        `🕒 Pukul: *${nextA.time_hhmm} WIB* _(sekitar ${diff} menit lagi)_\n` +
        `📝 Detail: ${nextA.message_body}`;
      db.prepare(
        `INSERT INTO chat_histories (sender_jid, role, message) VALUES (?, 'model', ?)`,
      ).run(senderJid, reply);
      return reply;
    }
  }

  // E. Deteksi pencarian agenda berdasarkan kata kunci judul/topik (Contoh: "kapan rapat evaluasi?", "jam berapa standup?", "jadwal server")
  const stopWords = [
    "halo",
    "bot",
    "tampilkan",
    "semua",
    "agenda",
    "untuk",
    "hari",
    "jadwal",
    "kapan",
    "jam",
    "berapa",
    "apa",
    "yang",
    "ada",
    "di",
    "pada",
    "tolong",
    "cek",
    "info",
  ];
  const keywords = lowerMsg
    .replace(/[^\w\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !stopWords.includes(w));

  if (keywords.length > 0) {
    const matchedAgendas = allAgendas.filter((a) =>
      keywords.some(
        (kw) =>
          a.title.toLowerCase().includes(kw) ||
          a.message_body.toLowerCase().includes(kw),
      ),
    );

    if (matchedAgendas.length > 0 && !genAI) {
      let reply = `🔍 *Hasil Pencarian Agenda Terkait "${keywords.join(" ")}":*\n\n`;
      matchedAgendas.forEach((a) => {
        reply += `• *[ID #${a.id}] ${a.title}*\n  🕒 Jadwal: *${a.schedule_label}*\n  📝 Detail: ${a.message_body}\n\n`;
      });
      db.prepare(
        `INSERT INTO chat_histories (sender_jid, role, message) VALUES (?, 'model', ?)`,
      ).run(senderJid, reply);
      return reply;
    }
  }

  // ------------------------------------------------------------------------
  // LAPIS 2: JIKA GEMINI_API_KEY TERISI, GUNAKAN FULL LLM DENGAN KONTEKS LENGKAP
  // ------------------------------------------------------------------------
  if (genAI) {
    try {
      const aiConfig = db
        .prepare("SELECT * FROM ai_configs WHERE id = 1")
        .get();
      const historyRows = db
        .prepare(
          `SELECT role, message FROM chat_histories WHERE sender_jid = ? ORDER BY id DESC LIMIT 6`,
        )
        .all(senderJid)
        .reverse();
      const agendaContext = allAgendas
        .map(
          (a) =>
            `- [ID #${a.id}] ${a.title} | Hari: ${a.day_name} | Jam: ${a.time_hhmm} WIB | Detail: ${a.message_body}`,
        )
        .join("\n");

      const model = genAI.getGenerativeModel({
        model: aiConfig?.model_name || "gemini-2.5-flash",
      });
      const fullPrompt =
        `${aiConfig?.system_prompt}\n\n` +
        `Waktu Sekarang: Hari ${dayName}, Pukul ${timeStr} WIB.\n` +
        `Daftar Lengkap Agenda di Database:\n${agendaContext || "Belum ada agenda"}\n\n` +
        `Panduan Perintah Bot (jika user bertanya cara tambah/edit/hapus):\n` +
        `- Tambah agenda rutin: !tambah Judul | Hari, HH:MM | Isi Pesan\n` +
        `- Tambah agenda sekali jalan (otomatis hapus setelah lewat): !tambahsekali Judul | Hari, HH:MM | Isi Pesan\n` +
        `- Edit agenda: !edit ID | Judul Baru | Hari, HH:MM | Isi Pesan\n` +
        `- Hapus agenda: !hapus ID\n` +
        `- Share ke semua grup: !share ID atau !sharesemua\n\n` +
        `Riwayat Percakapan:\n` +
        historyRows
          .map((h) => `${h.role === "user" ? "User" : "Asisten"}: ${h.message}`)
          .join("\n") +
        `\nAsisten (jawab secara spesifik, ramah, dan langsung menjawab pertanyaan User):`;

      const result = await model.generateContent(fullPrompt);
      const replyText = result.response.text();
      db.prepare(
        `INSERT INTO chat_histories (sender_jid, role, message) VALUES (?, 'model', ?)`,
      ).run(senderJid, replyText);
      return replyText;
    } catch (err) {
      console.error("[GEMINI API ERROR]:", err.message);
    }
  }

  // ------------------------------------------------------------------------
  // LAPIS 3: SMART FALLBACK (JIKA PERTANYAAN UMUM DI LUAR AGENDA & TANPA API KEY)
  // ------------------------------------------------------------------------
  const todayList = allAgendas.filter(
    (a) => a.day_name.toLowerCase() === dayName.toLowerCase(),
  );
  let fallback =
    `Halo! 👋 Saya *Asisten AI Pengelola Agenda*.\n` +
    `Saat ini hari *${dayName}, pukul ${timeStr} WIB*.\n\n`;

  if (todayList.length > 0) {
    fallback += `📌 *Agenda Hari Ini (${dayName}):*\n`;
    todayList.forEach((a) => {
      fallback += `• *${a.time_hhmm} WIB* — ${a.title} (ID #${a.id})\n`;
    });
    fallback += `\n`;
  } else {
    fallback += `📌 Hari ini (${dayName}) tidak ada agenda terjadwal.\n\n`;
  }

  fallback +=
    `💡 *Tips Pertanyaan Cepat:*\n` +
    `• Ketik *"Agenda hari Senin"* (atau hari lainnya) untuk melihat jadwal spesifik.\n` +
    `• Ketik *"Tampilkan semua agenda"* untuk melihat seluruh jadwal.\n` +
    `• Ketik *"Agenda terdekat"* untuk melihat acara berikutnya.\n` +
    `• Ketik *!menu* untuk melihat cara *Tambah, Edit, Hapus, & Broadcast Agenda*.`;

  db.prepare(
    `INSERT INTO chat_histories (sender_jid, role, message) VALUES (?, 'model', ?)`,
  ).run(senderJid, fallback);
  return fallback;
}

function getFormattedMenuText() {
  const sessionRow = db
    .prepare(
      "SELECT access_mode FROM wa_sessions WHERE session_id = 'primary_session'",
    )
    .get();
  const modeLabel =
    sessionRow?.access_mode === "public"
      ? "🔓 PUBLIK (Semua Anggota Bisa CRUD)"
      : "🔒 ADMIN ONLY (Hanya Admin Bisa CRUD)";

  return (
    `🤖 *PANDUAN LENGKAP WHATSAPP AI & AGENDA BOT*\n` +
    `🛡️ *Mode Hak Akses Saat Ini:* ${modeLabel}\n\n` +
    `📋 *A. PERINTAH LIHAT & BROADCAST AGENDA*\n` +
    `• *!listagenda* — Lihat semua agenda aktif\n` +
    `• *!share <ID>* — Kirim 1 agenda spesifik ke seluruh grup terdaftar\n` +
    `• *!sharesemua* — Kirim rekap seluruh agenda sekaligus ke semua grup\n\n` +
    `✏️ *B. PERINTAH TAMBAH, EDIT, & HAPUS (CRUD)*\n` +
    `• *!tambah Judul | Hari, HH:MM | Isi Pesan*\n` +
    `  _(Contoh: !tambah Rapat Tim | Selasa, 11:30 | Bahas UI/UX)_\n` +
    `• *!tambahsekali Judul | Hari, HH:MM | Isi Pesan*\n` +
    `  _(Otomatis terhapus setelah jamnya terlewati!)_\n` +
    `• *!edit ID | Judul Baru | Hari, HH:MM | Isi Baru*\n` +
    `  _(Contoh: !edit 1 | Standup Pagi | Senin, 08:30 | Update sprint)_\n` +
    `• *!hapus <ID>* — Hapus agenda secara manual (Contoh: *!hapus 10*)\n` +
    `• *!bersihkan* — Hapus semua agenda sekali jalan yang sudah lewat jamnya\n\n` +
    `⚙️ *C. PENGATURAN HAK AKSES & SISTEM*\n` +
    `• *!akses publik* — Izinkan semua orang di grup menambah/edit/hapus agenda\n` +
    `• *!akses admin* — Batasi hanya Admin yang bisa menambah/edit/hapus\n` +
    `• *!tambahadmin 62812xxx* — Tambah nomor rekan sebagai Admin\n` +
    `• *!status* — Cek status bot, pengingat otomatis, & database\n\n` +
    `💬 *TANYA AI SECARA NATURAL (TANPA TANDA !):*\n` +
    `Cukup ketik langsung seperti:\n` +
    `• _"Semua agenda hari senin"_\n` +
    `• _"Jadwal hari selasa apa saja?"_\n` +
    `• _"Kapan jadwal code review?"_`
  );
}

// Helper memisahkan "Hari, HH:MM" (Contoh: "Senin, 14:30" atau "14:30")
function parseScheduleInput(rawSchedule) {
  const { dayName } = getCurrentTimeInfo();
  const timeMatch = rawSchedule.match(/(\d{1,2})[:.](\d{2})/);
  const hhmm = timeMatch
    ? `${String(timeMatch[1]).padStart(2, "0")}:${timeMatch[2]}`
    : "09:00";

  let detectedDay = dayName;
  for (const d of DAYS_MAP) {
    if (rawSchedule.toLowerCase().includes(d.toLowerCase())) {
      detectedDay = d;
      break;
    }
  }
  if (
    rawSchedule.toLowerCase().includes("harian") ||
    rawSchedule.toLowerCase().includes("setiap hari")
  ) {
    detectedDay = "Harian";
  }

  return {
    day_name: detectedDay,
    time_hhmm: hhmm,
    schedule_label: `${detectedDay}, ${hhmm} WIB`,
  };
}

// ============================================================================
// 5. KONEKSI BAILEYS WHATSAPP SOCKET & HANDLER PERINTAH LENGKAP
// ============================================================================
async function connectToWhatsApp() {
  const authFolder = "./auth_info_baileys";
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(
    `[BAILEYS INIT] Menggunakan WA Web v${version.join(".")} (isLatest: ${isLatest})`,
  );

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: "silent" }),
    browser: Browsers.appropriate("Desktop"),
    printQRInTerminal: false,
    syncFullHistory: false,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = "scan_qr";
      currentQRBase64 = await QRCode.toDataURL(qr);
      console.log("\n📱 [BAILEYS LOGIN] SCAN QR CODE DI BAWAH INI:");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "close") {
      connectionStatus = "disconnected";
      currentQRBase64 = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      if (statusCode === DisconnectReason.loggedOut || statusCode === 405) {
        try {
          fs.rmSync(authFolder, { recursive: true, force: true });
        } catch (e) {}
        setTimeout(connectToWhatsApp, 3000);
      } else {
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === "open") {
      connectionStatus = "connected";
      currentQRBase64 = null;
      connectedPhone = sock.user?.id ? sock.user.id.split(":")[0] : "Connected";

      db.prepare(
        `
                UPDATE wa_sessions SET phone_number = ?, status = 'connected', last_connected = CURRENT_TIMESTAMP
                WHERE session_id = 'primary_session'
            `,
      ).run(connectedPhone);

      console.log(`\n✅ [BAILEYS TERHUBUNG] Nomor Aktif: ${connectedPhone}`);
      console.log(
        `🛡️ [SANDBOX AKTIF] Pengingat otomatis H-60m, H-30m, H-0, & Auto-Delete siap bekerja!\n`,
      );
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    const m = messages[0];
    if (!m.message) return;
    if (botSentMessageIds.has(m.key.id)) return;

    const senderJid = m.key.remoteJid;
    const text = (
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ""
    ).trim();
    if (!text) return;

    // Cegah bot membalas pesan outputnya sendiri
    const botPrefixes = [
      "🤖",
      "📢",
      "✅",
      "📅",
      "⏳",
      "🚀",
      "📊",
      "🛑",
      "⚠️",
      "❌",
      "📋",
      "🗑️",
      "⏰",
      "🔍",
      "Halo! 👋",
      "🔓",
      "🔒",
    ];
    if (botPrefixes.some((p) => text.startsWith(p))) return;

    // Hanya proses pesan di dalam Grup
    if (!senderJid.endsWith("@g.us")) return;

    // Pendaftaran Grup Sandbox via "!daftartest"
    if (text.toLowerCase() === "!daftartest") {
      try {
        const groupMeta = await sock.groupMetadata(senderJid);
        db.prepare(
          `
                    INSERT OR REPLACE INTO contacts_groups (jid, name, type, category_tag, is_active)
                    VALUES (?, ?, 'group', 'SANDBOX_TEST', 1)
                `,
        ).run(senderJid, groupMeta.subject);

        await safeSendMessage(senderJid, {
          text:
            `✅ *[GRUP SANDBOX TERDAFTAR]*\n\n` +
            `Grup *"${groupMeta.subject}"* telah aktif.\n` +
            `Ketik *!menu* (atau cukup ketik *menu*) untuk melihat panduan lengkap fitur CRUD, Pengingat Otomatis (60m/30m), dan tanya-jawab AI.`,
        });
      } catch (err) {}
      return;
    }

    if (text.toLowerCase() === "!unregtest") {
      db.prepare("DELETE FROM contacts_groups WHERE jid = ?").run(senderJid);
      await safeSendMessage(senderJid, {
        text: `🛑 Grup ini telah dinonaktifkan dari daftar Sandbox.`,
      });
      return;
    }

    // Pastikan grup sudah terdaftar di Sandbox
    const isRegisteredSandbox = db
      .prepare("SELECT id FROM contacts_groups WHERE jid = ? AND is_active = 1")
      .get(senderJid);
    if (!isRegisteredSandbox) return;

    // ====================================================================
    // PARSER PERINTAH DENGAN AWALAN "!"
    // ====================================================================
    if (text.startsWith("!")) {
      const args = text.split(" ");
      const cmd = args[0].toLowerCase();

      if (cmd === "!menu" || cmd === "!help") {
        await safeSendMessage(senderJid, { text: getFormattedMenuText() });
        return;
      }

      if (cmd === "!listagenda") {
        const agendas = db
          .prepare(
            "SELECT * FROM agendas WHERE status = 'active' ORDER BY id ASC",
          )
          .all();
        if (agendas.length === 0) {
          await safeSendMessage(senderJid, {
            text: "📭 Belum ada agenda aktif saat ini.",
          });
          return;
        }
        let listText = `📅 *DAFTAR ${agendas.length} AGENDA AKTIF*\n\n`;
        agendas.forEach((a) => {
          const badge = a.auto_delete_after
            ? "🗑️ _[Auto-Hapus Jika Lewat]_"
            : "🔄 _[Rutin]_";
          listText +=
            `*ID #${a.id} — ${a.title}* ${badge}\n` +
            `🕒 Jadwal: ${a.schedule_label}\n` +
            `📝 Pesan: ${a.message_body}\n\n`;
        });
        await safeSendMessage(senderJid, { text: listText });
        return;
      }

      // --- FITUR PROTEKSI HAK AKSES UNTUK CRUD & BROADCAST ---
      const hasAccess = checkUserPermission(m);

      // 1. TAMBAH AGENDA (RUTIN MAUPUN SEKALI JALAN / AUTO-DELETE)
      if (
        cmd === "!tambah" ||
        cmd === "!tambahagenda" ||
        cmd === "!tambahsekali"
      ) {
        if (!hasAccess) {
          await safeSendMessage(senderJid, {
            text: "❌ *Akses Ditolak:* Saat ini fitur Tambah/Edit/Hapus diatur hanya untuk *Admin*. Admin dapat mengetik *!akses publik* jika ingin mengizinkan semua anggota.",
          });
          return;
        }

        const isOneTimeAutoDelete = cmd === "!tambahsekali" ? 1 : 0;
        const rawBody = text.substring(cmd.length).trim();
        const parts = rawBody.split("|").map((s) => s.trim());

        if (parts.length < 3) {
          await safeSendMessage(senderJid, {
            text: `⚠️ *Format Tambah Agenda:*\n*${cmd} Judul Agenda | Hari, HH:MM | Isi Pesan*\n\nContoh:\n*${cmd} Review Sprint | Selasa, 14:30 | Evaluasi progres mingguan bersama tim*`,
          });
          return;
        }

        const { day_name, time_hhmm, schedule_label } = parseScheduleInput(
          parts[1],
        );
        const info = db
          .prepare(
            `
                    INSERT INTO agendas (title, day_name, time_hhmm, message_body, schedule_label, is_recurring, auto_delete_after, source)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 'wa_command')
                `,
          )
          .run(
            parts[0],
            day_name,
            time_hhmm,
            parts[2],
            schedule_label,
            isOneTimeAutoDelete ? 0 : 1,
            isOneTimeAutoDelete,
          );

        await safeSendMessage(senderJid, {
          text:
            `✅ *AGENDA BERHASIL DITAMBAHKAN (ID #${info.lastInsertRowid})*\n\n` +
            `📌 *Judul:* ${parts[0]}\n` +
            `🕒 *Jadwal:* ${schedule_label}\n` +
            `🔄 *Tipe:* ${isOneTimeAutoDelete ? "Sekali Jalan (Otomatis Terhapus Setelah Lewat Waktu)" : "Rutin Mingguan"}\n` +
            `🔔 *Pengingat Otomatis:* Aktif pada H-60 menit, H-30 menit, & saat waktu tiba.`,
        });
        return;
      }

      // 2. EDIT AGENDA
      if (cmd === "!edit" || cmd === "!editagenda") {
        if (!hasAccess) {
          await safeSendMessage(senderJid, {
            text: "❌ *Akses Ditolak:* Hanya Admin yang dapat mengedit agenda.",
          });
          return;
        }

        const rawBody = text.substring(cmd.length).trim();
        const parts = rawBody.split("|").map((s) => s.trim());
        if (parts.length < 4) {
          await safeSendMessage(senderJid, {
            text: `⚠️ *Format Edit Agenda:*\n*!edit ID | Judul Baru | Hari, HH:MM | Isi Pesan Baru*\n\nContoh:\n*!edit 1 | Daily Standup Pagi | Senin, 08:30 | Standup diundur ke jam 08.30 WIB*`,
          });
          return;
        }

        const targetId = parseInt(parts[0].replace("#", ""));
        const existing = db
          .prepare("SELECT * FROM agendas WHERE id = ?")
          .get(targetId);
        if (!existing) {
          await safeSendMessage(senderJid, {
            text: `❌ Agenda dengan ID #${targetId} tidak ditemukan.`,
          });
          return;
        }

        const { day_name, time_hhmm, schedule_label } = parseScheduleInput(
          parts[2],
        );
        db.prepare(
          `
                    UPDATE agendas
                    SET title = ?, day_name = ?, time_hhmm = ?, message_body = ?, schedule_label = ?,
                        reminded_60m = '', reminded_30m = '', reminded_0m = ''
                    WHERE id = ?
                `,
        ).run(
          parts[1],
          day_name,
          time_hhmm,
          parts[3],
          schedule_label,
          targetId,
        );

        await safeSendMessage(senderJid, {
          text:
            `✅ *AGENDA #${targetId} BERHASIL DIPERBARUI*\n\n` +
            `📌 *Judul Baru:* ${parts[1]}\n` +
            `🕒 *Jadwal Baru:* ${schedule_label}\n` +
            `📝 *Pesan Baru:* ${parts[3]}`,
        });
        return;
      }

      // 3. HAPUS AGENDA MANUAL
      if (cmd === "!hapus" || cmd === "!delete" || cmd === "!hapusagenda") {
        if (!hasAccess) {
          await safeSendMessage(senderJid, {
            text: "❌ *Akses Ditolak:* Hanya Admin yang dapat menghapus agenda.",
          });
          return;
        }

        const targetId = parseInt((args[1] || "").replace("#", ""));
        if (!targetId) {
          await safeSendMessage(senderJid, {
            text: "⚠️ Gunakan format: *!hapus <ID>* (Contoh: *!hapus 5*)",
          });
          return;
        }

        const existing = db
          .prepare("SELECT * FROM agendas WHERE id = ?")
          .get(targetId);
        if (!existing) {
          await safeSendMessage(senderJid, {
            text: `❌ Agenda #${targetId} tidak ditemukan.`,
          });
          return;
        }

        db.prepare("DELETE FROM agendas WHERE id = ?").run(targetId);
        await safeSendMessage(senderJid, {
          text: `🗑️ Agenda *#${targetId} (${existing.title})* berhasil dihapus secara permanen.`,
        });
        return;
      }

      // 4. BERSIHKAN AGENDA YANG SUDAH LEWAT SECARA MANUAL
      if (cmd === "!bersihkan") {
        if (!hasAccess) {
          await safeSendMessage(senderJid, {
            text: "❌ *Akses Ditolak:* Hanya Admin yang dapat menjalankan pembersihan.",
          });
          return;
        }
        const { dayName, totalMinutes } = getCurrentTimeInfo();
        const all = db
          .prepare("SELECT * FROM agendas WHERE status = 'active'")
          .all();
        let deletedCount = 0;
        for (const a of all) {
          const aMin = parseHHMMToMinutes(a.time_hhmm);
          if (
            a.day_name.toLowerCase() === dayName.toLowerCase() &&
            aMin !== null &&
            aMin < totalMinutes
          ) {
            db.prepare("DELETE FROM agendas WHERE id = ?").run(a.id);
            deletedCount++;
          }
        }
        await safeSendMessage(senderJid, {
          text: `🗑️ Pembersihan selesai: *${deletedCount} agenda* hari ini (${dayName}) yang waktunya telah terlewati berhasil dihapus.`,
        });
        return;
      }

      // 5. SHARE SALAH SATU AGENDA KE SELURUH GRUP TERDAFTAR
      if (cmd === "!share") {
        if (!hasAccess) {
          await safeSendMessage(senderJid, {
            text: "❌ *Akses Ditolak:* Hanya Admin yang dapat melakukan broadcast ke seluruh grup.",
          });
          return;
        }
        const id = parseInt((args[1] || "").replace("#", ""));
        if (!id) {
          await safeSendMessage(senderJid, {
            text: "⚠️ Gunakan format: *!share <ID>* (Contoh: *!share 1*)",
          });
          return;
        }
        const res = await broadcastSingleAgenda(id, "manual_single");
        if (res.success) {
          await safeSendMessage(senderJid, {
            text: `✅ Agenda *#${id} (${res.agenda.title})* berhasil dikirimkan ke *${res.sentCount} grup terdaftar*!`,
          });
        } else {
          await safeSendMessage(senderJid, {
            text: `❌ Gagal: ${res.message}`,
          });
        }
        return;
      }

      // 6. SHARE KESELURUHAN AGENDA KE SELURUH GRUP TERDAFTAR
      if (cmd === "!sharesemua") {
        if (!hasAccess) {
          await safeSendMessage(senderJid, {
            text: "❌ *Akses Ditolak:* Hanya Admin yang dapat melakukan broadcast ke seluruh grup.",
          });
          return;
        }
        const res = await broadcastAllAgendasSummary();
        if (res.success) {
          await safeSendMessage(senderJid, {
            text: `✅ Rekapitulasi *${res.totalAgendas} agenda* berhasil dikirimkan ke *${res.sentCount} grup terdaftar*!`,
          });
        } else {
          await safeSendMessage(senderJid, {
            text: `❌ Gagal: ${res.message}`,
          });
        }
        return;
      }

      // 7. PENGATURAN MODE HAK AKSES (ADMIN ONLY vs SEMUA ORANG / PUBLIK)
      if (cmd === "!akses") {
        const sub = (args[1] || "").toLowerCase();
        if (sub === "publik" || sub === "semua" || sub === "public") {
          db.prepare(
            "UPDATE wa_sessions SET access_mode = 'public' WHERE session_id = 'primary_session'",
          ).run();
          await safeSendMessage(senderJid, {
            text: `🔓 *MODE AKSES: PUBLIK*\nSekarang **semua anggota grup** dapat menambah, mengedit, menghapus, dan membagikan agenda.`,
          });
        } else if (sub === "admin") {
          db.prepare(
            "UPDATE wa_sessions SET access_mode = 'admin_only' WHERE session_id = 'primary_session'",
          ).run();
          await safeSendMessage(senderJid, {
            text: `🔒 *MODE AKSES: ADMIN ONLY*\nSekarang hanya **Admin** yang dapat menambah, mengedit, menghapus, dan membagikan agenda.`,
          });
        } else {
          await safeSendMessage(senderJid, {
            text: "⚙️ Gunakan: *!akses publik* (semua orang bisa kelola) atau *!akses admin* (hanya admin).",
          });
        }
        return;
      }

      if (cmd === "!tambahadmin") {
        const num = (args[1] || "").replace(/\D/g, "");
        if (!num) {
          await safeSendMessage(senderJid, {
            text: "⚠️ Format: *!tambahadmin 62812xxxxxxx*",
          });
          return;
        }
        db.prepare(
          "INSERT OR REPLACE INTO users (jid, name, role) VALUES (?, ?, ?)",
        ).run(`${num}@s.whatsapp.net`, `Admin ${num}`, "admin");
        await safeSendMessage(senderJid, {
          text: `✅ Nomor *${num}* berhasil ditambahkan sebagai Admin.`,
        });
        return;
      }

      if (cmd === "!status") {
        const totalAgendas = db
          .prepare("SELECT count(*) as c FROM agendas")
          .get().c;
        const totalTargets = db
          .prepare(
            "SELECT count(*) as c FROM contacts_groups WHERE is_active = 1",
          )
          .get().c;
        const totalLogs = db
          .prepare("SELECT count(*) as c FROM broadcast_logs")
          .get().c;
        const sessionRow = db
          .prepare(
            "SELECT access_mode FROM wa_sessions WHERE session_id = 'primary_session'",
          )
          .get();
        const { dayName, timeStr } = getCurrentTimeInfo();

        await safeSendMessage(senderJid, {
          text:
            `📊 *STATUS SISTEM WA AI BOT*\n` +
            `• Waktu Server: ${dayName}, ${timeStr} WIB\n` +
            `• Status Koneksi: ${connectionStatus}\n` +
            `• Mode Akses CRUD: *${sessionRow?.access_mode === "public" ? "Publik (Semua Orang)" : "Admin Only"}*\n` +
            `• Grup Terdaftar: ${totalTargets} Grup\n` +
            `• Total Agenda Aktif: ${totalAgendas} Agenda\n` +
            `• Total Broadcast Terkirim: ${totalLogs} Pesan\n` +
            `• Engine Pengingat: Aktif (H-60m, H-30m, & H-0)`,
        });
        return;
      }
    }

    // ====================================================================
    // JIKA BUKAN PERINTAH "!", PROSES DENGAN HYBRID SMART AI ASSISTANT
    // ====================================================================
    await sock.sendPresenceUpdate("composing", senderJid);
    const aiReply = await generateSmartAIResponse(senderJid, text);
    await safeSendMessage(senderJid, { text: aiReply }, { quoted: m });
  });
}

// ============================================================================
// 6. REST API UNTUK WEB DASHBOARD 6 MENU (MENDUKUNG CRUD PENUH)
// ============================================================================
app.get("/api/overview", (req, res) => {
  const sessionRow = db
    .prepare("SELECT * FROM wa_sessions WHERE session_id = 'primary_session'")
    .get();
  const agendas = db.prepare("SELECT * FROM agendas ORDER BY id ASC").all();
  const contacts = db
    .prepare("SELECT * FROM contacts_groups ORDER BY id DESC")
    .all();
  const logs = db
    .prepare("SELECT * FROM broadcast_logs ORDER BY id DESC LIMIT 30")
    .all();
  const aiConfig = db.prepare("SELECT * FROM ai_configs WHERE id = 1").get();
  const chats = db
    .prepare("SELECT * FROM chat_histories ORDER BY id DESC LIMIT 20")
    .all();

  res.json({
    session: {
      status: connectionStatus,
      phone: connectedPhone,
      qr: currentQRBase64,
      access_mode: sessionRow?.access_mode || "admin_only",
    },
    agendas,
    contacts,
    logs,
    aiConfig,
    chats,
  });
});

// API Tambah Agenda dari Web
app.post("/api/agendas", (req, res) => {
  const { title, day_name, time_hhmm, message_body, auto_delete_after } =
    req.body;
  const schedule_label = `${day_name}, ${time_hhmm} WIB`;
  db.prepare(
    `
        INSERT INTO agendas (title, day_name, time_hhmm, message_body, schedule_label, is_recurring, auto_delete_after, source)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'web_dashboard')
    `,
  ).run(
    title,
    day_name,
    time_hhmm,
    message_body,
    schedule_label,
    auto_delete_after ? 0 : 1,
    auto_delete_after ? 1 : 0,
  );
  res.json({ success: true });
});

// API Edit Agenda dari Web
app.put("/api/agendas/:id", (req, res) => {
  const { title, day_name, time_hhmm, message_body, auto_delete_after } =
    req.body;
  const schedule_label = `${day_name}, ${time_hhmm} WIB`;
  db.prepare(
    `
        UPDATE agendas SET title = ?, day_name = ?, time_hhmm = ?, message_body = ?, schedule_label = ?, auto_delete_after = ?,
        reminded_60m = '', reminded_30m = '', reminded_0m = ''
        WHERE id = ?
    `,
  ).run(
    title,
    day_name,
    time_hhmm,
    message_body,
    schedule_label,
    auto_delete_after ? 1 : 0,
    req.params.id,
  );
  res.json({ success: true });
});

// API Hapus Agenda dari Web
app.delete("/api/agendas/:id", (req, res) => {
  db.prepare("DELETE FROM agendas WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// API Share 1 Agenda ke Semua Grup
app.post("/api/agendas/:id/trigger", async (req, res) => {
  const result = await broadcastSingleAgenda(req.params.id, "manual_single");
  res.json(result);
});

// API Share Keseluruhan Agenda ke Semua Grup
app.post("/api/agendas/broadcast-all", async (req, res) => {
  const result = await broadcastAllAgendasSummary();
  res.json(result);
});

// API Ubah Mode Hak Akses (Admin Only / Public)
app.post("/api/access-mode", (req, res) => {
  const { access_mode } = req.body;
  db.prepare(
    "UPDATE wa_sessions SET access_mode = ? WHERE session_id = 'primary_session'",
  ).run(access_mode);
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server & Dashboard 6 Menu aktif di http://localhost:${PORT}`);
  startSmartSchedulerEngine();
  connectToWhatsApp();
});
