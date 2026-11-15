# 🤖 WhatsApp AI Chatbot & Automated Agenda Broadcast System

Sistem otomasi komunikasi internal berbasis **WhatsApp WebSocket Multi-Device (`@whiskeysockets/baileys`)** yang diintegrasikan dengan **Hybrid AI Assistant (Local NLU + Google Gemini API)** serta **Smart Background Cron Scheduler**.

Proyek ini dirancang untuk mengelola, menjadwalkan, dan mengirimkan pengingat agenda kegiatan secara otomatis ke seluruh grup/kontak yang terdaftar tanpa perlu membuka atau login ke dashboard web (_Zero-Web-Login Execution_).

---

## ✨ Fitur yang Telah Diimplementasikan (Current Progress)

Berikut adalah daftar modul dan fitur yang telah selesai dibangun pada tahap pengembangan saat ini:

1. **Koneksi Persisten WhatsApp Multi-Device (Baileys API)**
   - Mendukung autentikasi via QR Code (Terminal & Web Dashboard).
   - Menyimpan sesi autentikasi secara persisten menggunakan `useMultiFileAuthState`.
   - Dilengkapi mekanisme _Auto-Reconnect_ dan _Auto-Clean Session_ apabila sesi kedaluwarsa (`401`/`405`).
   - Mengambil versi protokol WhatsApp Web terbaru secara dinamis (`fetchLatestBaileysVersion`).

2. **Safe Sandbox Mode (`!daftartest`) & Proteksi Privasi**
   - Mengabaikan seluruh pesan pribadi (_Japri_) dan grup WhatsApp asli secara default agar aman digunakan saat pengujian.
   - Hanya merespons dan mengirim broadcast ke grup yang telah didaftarkan secara eksplisit menggunakan perintah `!daftartest`.

3. **Manajemen Agenda Lengkap (CRUD) & Auto-Delete via WhatsApp / Web**
   - **Create:** Menambah agenda rutin mingguan (`!tambah`) maupun agenda sekali jalan (`!tambahsekali`).
   - **Read:** Menampilkan seluruh daftar agenda aktif (`!listagenda`) atau memfilter agenda berdasarkan hari tertentu.
   - **Update:** Mengubah judul, hari/jam, dan isi pesan agenda secara langsung dari chat WhatsApp (`!edit`).
   - **Delete (Manual & Otomatis):** Menghapus agenda berdasarkan ID (`!hapus`), membersihkan agenda yang telah lewat (`!bersihkan`), serta **Auto-Delete otomatis** oleh _background worker_ ketika agenda berjenis sekali jalan telah melewati waktunya.

4. **Smart Multi-Stage Reminder & Automated Broadcast (`node-cron`)**
   - Memantau jadwal agenda setiap menit di latar belakang tanpa intervensi login web.
   - Mengirimkan **3 tahap pengingat otomatis** ke seluruh grup terdaftar:
     - ⏳ **H-60 Menit:** Pengingat kurang dari 1 jam sebelum agenda dimulai.
     - ⚠️ **H-30 Menit:** Pengingat 30 menit sebelum agenda dimulai.
     - 🔔 **H-0 (Waktu Tiba):** Pemberitahuan utama saat waktu agenda tiba.
   - Mendukung pengiriman manual satu agenda (`!share <ID>`) maupun rekap keseluruhan agenda sekaligus (`!sharesemua`) dengan jeda anti-ban (_rate-limiting delay_).

5. **Dual-Mode Role-Based Access Control (RBAC)**
   - Mendukung pembatasan hak akses fitur CRUD dan Broadcast dalam 2 mode yang dapat diubah langsung via chat:
     - 🔒 **Mode Admin Only (`!akses admin`):** Hanya nomor utama/admin terdaftar yang dapat menambah, mengedit, menghapus, dan membagikan agenda.
     - 🔓 **Mode Publik (`!akses publik`):** Seluruh anggota di dalam grup terdaftar diizinkan mengelola agenda.

6. **Hybrid Smart AI Assistant (Local NLU + Google Gemini LLM)**
   - **Lapis 1 (Local NLU & Typo-Tolerant):** Mampu mengenali perintah meski tanpa tanda seru atau _typo_ (seperti `menu`, `imenu`, `bantuan`), serta memfilter database secara langsung untuk pertanyaan bahasa alami seperti _"Semua agenda hari senin"_, _"Jadwal besok"_, atau _"Agenda terdekat hari ini"_.
   - **Lapis 2 (Google Gemini AI + Multi-Turn Memory):** Menjawab pertanyaan kontekstual yang lebih kompleks dengan menyertakan riwayat percakapan dari tabel `chat_histories` dan konteks jadwal aktif.

7. **Web Dashboard 6 Menu Utama & 7 Tabel Database Relasional**
   - Antarmuka web berbasis _Tailwind CSS_ yang mencakup 6 menu manajemen bot dan terhubung langsung ke REST API serta 7 tabel SQLite.

---

## 🛠️ Tech Stack

| Kategori                | Teknologi / Library        | Kegunaan                                                                  |
| :---------------------- | :------------------------- | :------------------------------------------------------------------------ |
| **Runtime Environment** | Node.js (CommonJS)         | Eksekusi server backend dan background worker                             |
| **WhatsApp Engine**     | `@whiskeysockets/baileys`  | Koneksi protokol WebSocket Multi-Device WhatsApp                          |
| **AI / LLM Engine**     | `@google/generative-ai`    | Integrasi model Gemini (`gemini-2.5-flash`) & NLU Lokal                   |
| **Database**            | SQLite (`better-sqlite3`)  | Penyimpanan lokal cepat untuk 7 tabel relasional                          |
| **Task Scheduler**      | `node-cron`                | Eksekusi pengingat otomatis (H-60m, H-30m, H-0) & Auto-Delete             |
| **Web Server & UI**     | Express.js + Tailwind CSS  | REST API internal dan tampilan Mockup Dashboard 6 Menu                    |
| **Utilities**           | `pino`, `qrcode`, `dotenv` | Logging performa tinggi, generator QR Code, dan manajemen `.env`          |

---

## 💻 System Requirements

Sebelum menjalankan proyek ini di perangkat lokal atau server, pastikan lingkungan pengembangan memenuhi spesifikasi berikut:

- **Sistem Operasi:** Windows 10/11, Linux (Ubuntu 20.04+), atau macOS.
- **Node.js:** Versi `18.x` atau `20.x LTS` (Direkomendasikan `v20+`).
- **NPM:** Versi `9.x` ke atas (terinstal otomatis bersama Node.js).
- **Build Tools (Opsional untuk Windows):** Jika instalasi `better-sqlite3` meminta kompilasi native, pastikan C++ Build Tools / MinGW telah tersedia.
- **RAM Minimum:** ~100 MB ruang memori bebas (sangat ringan karena tanpa _headless browser_ Puppeteer).
- **Akun WhatsApp:** Disarankan menggunakan nomor khusus pengembangan atau menggunakan fitur **Grup Sandbox (`!daftartest`)** yang telah disediakan.

---

## 📂 Struktur Direktori Proyek

```text
wa-ai-baileys-fullstack/
├── public/
│   └── index.html          # Antarmuka Web Dashboard (6 Menu Utama)
├── auth_info_baileys/      # Folder sesi login WA (Otomatis dibuat, di-ignore oleh Git)
├── database.js             # Skema 7 tabel SQLite & Auto-Seeder 10 agenda awal
├── index.js                # Core Engine (Baileys Socket, Cron Reminder, Hybrid AI, Express API)
├── chatbot_system.db       # File database SQLite (Otomatis dibuat saat aplikasi berjalan)
├── .env.example            # Template konfigurasi environment variable untuk tim
├── .gitignore              # Daftar file sensitif yang tidak di-push ke GitHub
├── package.json            # Daftar dependensi dan skrip NPM
└── README.md               # Dokumentasi proyek
```

---

## 🗄️ Arsitektur 7 Tabel Database (`chatbot_system.db`)

1. **`users`**: Menyimpan daftar nomor administrator yang berhak mengelola agenda pada mode `admin_only`.
2. **`wa_sessions`**: Menyimpan status koneksi perangkat WhatsApp, nomor aktif, dan mode hak akses (`admin_only` / `public`).
3. **`contacts_groups`**: Menyimpan daftar JID grup/kontak target broadcast yang telah diaktifkan.
4. **`agendas`**: Menyimpan data agenda, hari, jam (`HH:MM`), sifat agenda (rutin / sekali jalan auto-delete), dan penanda status pengingat (`reminded_60m`, `reminded_30m`, `reminded_0m`).
5. **`broadcast_logs`**: Mencatat _audit trail_ setiap pengiriman pesan otomatis maupun manual.
6. **`ai_configs`**: Menyimpan konfigurasi _System Prompt_, nama model AI, dan _temperature_.
7. **`chat_histories`**: Menyimpan riwayat percakapan pengguna untuk mendukung memori multi-percakapan (_multi-turn conversation_).

---

## 🚀 Cara Instalasi & Menjalankan Proyek

Ikuti langkah-langkah berikut setelah melakukan _clone_ repositori ini dari GitHub:

### 1. Clone Repositori & Masuk ke Direktori

```bash
git clone [https://github.com/USERNAME_ANDA/NAMA_REPO_ANDA.git](https://github.com/USERNAME_ANDA/NAMA_REPO_ANDA.git)
cd NAMA_REPO_ANDA
```

### 2. Instalasi Seluruh Dependensi

```bash
npm install
```

### 3. Konfigurasi Environment Variable (`.env`)

Salin file `.env.example` menjadi `.env` (atau buat file baru bernama `.env` di _root_ proyek):

```env
PORT=3000
GEMINI_API_KEY=MASUKKAN_API_KEY_GEMINI_ANDA_DI_SINI
ADMIN_NUMBER=6281234567890@s.whatsapp.net
```

> **Catatan:** Jika `GEMINI_API_KEY` belum diisi, bot **tetap dapat berjalan normal** menggunakan mesin **Local Smart NLU** untuk menjawab pertanyaan terkait jadwal dan perintah pengelolaan agenda.

### 4. Jalankan Aplikasi

```bash
node index.js
```

### 5. Tautkan WhatsApp & Aktifkan Grup Sandbox

1. Setelah `node index.js` dijalankan, **QR Code** akan muncul di terminal (atau buka browser ke **`http://localhost:3000`** $\rightarrow$ **Menu 2**).
2. Buka WhatsApp di HP $\rightarrow$ **Perangkat Tertaut** $\rightarrow$ **Tautkan Perangkat**, lalu scan QR Code tersebut.
3. Buat sebuah **Grup WhatsApp khusus pengujian** di HP Anda.
4. Buka grup tersebut, lalu ketik:
   ```text
   !daftartest
   ```
5. Bot akan membalas bahwa grup tersebut telah terdaftar di dalam _Whitelist Sandbox_ dan siap menerima perintah maupun pengingat otomatis.

---

## 💬 Daftar Perintah Chatbot WhatsApp

| Perintah / Input Chat                       | Fungsi & Kegunaan                                                              |
| :------------------------------------------ | :----------------------------------------------------------------------------- |
| `!daftartest`                               | Mendaftarkan grup saat ini ke dalam Whitelist Sandbox agar direspon oleh bot   |
| `!unregtest`                                | Menghapus grup saat ini dari Whitelist Sandbox                                 |
| `!menu` atau `menu`                         | Menampilkan panduan lengkap seluruh perintah bot                               |
| `!listagenda`                               | Menampilkan seluruh daftar agenda aktif beserta ID dan jadwalnya               |
| `!tambah Judul \| Hari, HH:MM \| Isi`       | Menambahkan agenda rutin mingguan baru via chat WhatsApp                       |
| `!tambahsekali Judul \| Hari, HH:MM \| Isi` | Menambahkan agenda sekali jalan (otomatis terhapus setelah waktunya lewat)     |
| `!edit ID \| Judul \| Hari, HH:MM \| Isi`   | Mengubah data agenda berdasarkan nomor ID                                      |
| `!hapus <ID>`                               | Menghapus satu agenda secara manual berdasarkan ID                             |
| `!bersihkan`                                | Menghapus seluruh agenda hari ini yang jamnya telah terlewati                  |
| `!share <ID>`                               | Mengirimkan 1 agenda spesifik ke seluruh grup yang terdaftar                   |
| `!sharesemua`                               | Mengirimkan rekapitulasi seluruh agenda aktif ke semua grup terdaftar          |
| `!akses publik` / `!akses admin`            | Mengubah hak akses fitur CRUD (Semua Anggota vs Hanya Admin)                   |
| `!tambahadmin 62812xxx`                     | Menambahkan nomor WhatsApp anggota tim sebagai Admin                           |
| `!status`                                   | Menampilkan status server, mode akses, dan statistik 7 tabel database          |
| _"Semua agenda hari senin"_                 | Contoh pertanyaan natural ke AI untuk memfilter jadwal hari tertentu           |
| _"Agenda terdekat hari ini"_                | Contoh pertanyaan natural ke AI untuk mengecek jadwal berikutnya               |

---
