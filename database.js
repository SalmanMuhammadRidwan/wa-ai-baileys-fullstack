// database.js — 7 Tabel Database + Kolom Reminder (H-60, H-30, H-0) & Auto-Delete
const Database = require("better-sqlite3");
const db = new Database("./chatbot_system.db");

db.exec(`
    -- 1. Tabel Users (Manajemen Admin & Hak Akses)
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jid TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        role TEXT DEFAULT 'admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. Tabel WA Sessions (Status & Sesi Perangkat + Mode Akses CRUD)
    CREATE TABLE IF NOT EXISTS wa_sessions (
        session_id TEXT PRIMARY KEY,
        phone_number TEXT,
        status TEXT DEFAULT 'disconnected',
        access_mode TEXT DEFAULT 'admin_only', -- 'admin_only' atau 'public'
        last_connected DATETIME
    );

    -- 3. Tabel Contacts & Groups (Target Broadcast Grup Terdaftar)
    CREATE TABLE IF NOT EXISTS contacts_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        jid TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        type TEXT CHECK(type IN ('contact', 'group')) DEFAULT 'group',
        category_tag TEXT DEFAULT 'SANDBOX_TEST',
        is_active INTEGER DEFAULT 1
    );

    -- 4. Tabel Agendas (Mendukung CRUD, Pengingat 60m/30m/0m, & Auto-Delete)
    CREATE TABLE IF NOT EXISTS agendas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        day_name TEXT NOT NULL,           -- Senin, Selasa, Rabu, Kamis, Jumat, Sabtu, Minggu, atau Harian
        time_hhmm TEXT NOT NULL,          -- Format HH:MM (contoh: 08:00, 13:30)
        target_datetime TEXT,             -- Opsional: YYYY-MM-DD HH:MM untuk agenda sekali jalan
        message_body TEXT NOT NULL,
        schedule_label TEXT NOT NULL,
        is_recurring INTEGER DEFAULT 1,   -- 1 = Rutin Mingguan, 0 = Sekali jalan (otomatis terhapus setelah lewat)
        auto_delete_after INTEGER DEFAULT 0, -- 1 = Otomatis hapus setelah waktu agenda terlewati
        reminded_60m TEXT DEFAULT '',     -- Menyimpan tanggal terakhir pengingat H-60 dikirim
        reminded_30m TEXT DEFAULT '',     -- Menyimpan tanggal terakhir pengingat H-30 dikirim
        reminded_0m TEXT DEFAULT '',      -- Menyimpan tanggal terakhir notifikasi H-0 dikirim
        source TEXT DEFAULT 'system_init',
        status TEXT DEFAULT 'active',
        last_run DATETIME
    );

    -- 5. Tabel Broadcast Logs (Riwayat Pengiriman & Pengingat)
    CREATE TABLE IF NOT EXISTS broadcast_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agenda_id INTEGER,
        recipient_jid TEXT NOT NULL,
        broadcast_type TEXT DEFAULT 'main', -- 'remind_60m', 'remind_30m', 'main', 'manual_all'
        status TEXT CHECK(status IN ('sent', 'failed')),
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        error_msg TEXT
    );

    -- 6. Tabel AI Configs (Pengaturan Prompt & Parameter LLM)
    CREATE TABLE IF NOT EXISTS ai_configs (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        system_prompt TEXT NOT NULL,
        model_name TEXT DEFAULT 'gemini-2.5-flash',
        temperature REAL DEFAULT 0.4,
        is_active INTEGER DEFAULT 1
    );

    -- 7. Tabel Chat Histories (Memori Konteks Percakapan AI)
    CREATE TABLE IF NOT EXISTS chat_histories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_jid TEXT NOT NULL,
        role TEXT CHECK(role IN ('user', 'model')),
        message TEXT NOT NULL,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );
`);

// Seed Konfigurasi AI (Tabel 6)
const checkAiConfig = db
  .prepare("SELECT count(*) as count FROM ai_configs")
  .get();
if (checkAiConfig.count === 0) {
  db.prepare(
    `
        INSERT INTO ai_configs (id, system_prompt, model_name, temperature, is_active)
        VALUES (1, 'Anda adalah Asisten AI Pintar pengelola Agenda & Informasi Instansi. Jawablah setiap pertanyaan secara SPESIFIK, AKURAT, dan LANGSUNG ke inti jawaban berdasarkan data tabel agendas yang diberikan. Jika pengguna menanyakan agenda hari tertentu, sebutkan daftar agendanya secara rinci beserta jam dan pesannya.', 'gemini-2.5-flash', 0.4, 1)
    `,
  ).run();
}

// Seed Sesi Default (Tabel 2)
db.prepare(
  `
    INSERT OR IGNORE INTO wa_sessions (session_id, phone_number, status, access_mode)
    VALUES ('primary_session', '-', 'disconnected', 'admin_only')
`,
).run();

// Seed 10 Agenda Otomatis (Tabel 4)
const checkAgendas = db.prepare("SELECT count(*) as count FROM agendas").get();
if (checkAgendas.count === 0) {
  const insertAgenda = db.prepare(`
        INSERT INTO agendas (title, day_name, time_hhmm, message_body, schedule_label, is_recurring, auto_delete_after, source)
        VALUES (?, ?, ?, ?, ?, 1, 0, 'system_init')
    `);

  const default10Agendas = [
    [
      "Daily Standup Pagi",
      "Senin",
      "08:00",
      "Selamat pagi rekan-rekan! Mengingatkan agenda Daily Standup pukul 08:00 WIB. Mohon siapkan update progres harian Anda.",
      "Senin, 08:00 WIB",
    ],
    [
      "Sinkronisasi Target Mingguan",
      "Senin",
      "13:00",
      "Pengingat: Sesi sinkronisasi sprint dan pembagian task mingguan dimulai pukul 13:00 WIB.",
      "Senin, 13:00 WIB",
    ],
    [
      "Persiapan Bahan Evaluasi Selasa",
      "Selasa",
      "09:00",
      "Halo tim! Mohon merapikan draf laporan progres mingguan sebelum sesi presentasi pukul 10:00 WIB.",
      "Selasa, 09:00 WIB",
    ],
    [
      "Pelaporan & Presentasi Mingguan",
      "Selasa",
      "10:00",
      "AGENDA UTAMA: Sesi Pelaporan Tugas Mingguan & Briefing Tugas Baru dimulai pukul 10:00 WIB.",
      "Selasa, 10:00 WIB",
    ],
    [
      "Pemeliharaan Server & Backup",
      "Rabu",
      "09:00",
      "Informasi Teknis: Jadwal pengecekan rutin server dan backup database dilakukan hari ini pukul 09:00 WIB.",
      "Rabu, 09:00 WIB",
    ],
    [
      "Diskusi Teknis & Code Review",
      "Rabu",
      "15:30",
      "Pengingat sore: Sesi diskusi kendala teknis dan code review dimulai pukul 15:30 WIB.",
      "Rabu, 15:30 WIB",
    ],
    [
      "Sesi Sharing Knowledge Internal",
      "Kamis",
      "09:00",
      "Selamat pagi! Jangan lewatkan sesi berbagi materi teknis pukul 09:00 WIB hari ini.",
      "Kamis, 09:00 WIB",
    ],
    [
      "Pembaruan Dokumentasi & Logbook",
      "Kamis",
      "16:00",
      "Mengingatkan seluruh anggota tim untuk memperbarui dokumentasi progres dan pengisian logbook harian pukul 16:00 WIB.",
      "Kamis, 16:00 WIB",
    ],
    [
      "Briefing Pagi & Kebugaran Jumat",
      "Jumat",
      "08:00",
      "Selamat hari Jumat! Kegiatan pagi dimulai pukul 08:00 WIB dilanjutkan pengerjaan proyek mandiri.",
      "Jumat, 08:00 WIB",
    ],
    [
      "Rekapitulasi Capaian Akhir Pekan",
      "Jumat",
      "15:30",
      "Penutup pekan kerja: Pastikan seluruh target minggu ini telah terdokumentasi dengan baik pukul 15:30 WIB.",
      "Jumat, 15:30 WIB",
    ],
  ];

  const insertMany = db.transaction((items) => {
    for (const item of items) insertAgenda.run(...item);
  });
  insertMany(default10Agendas);
}

module.exports = db;
