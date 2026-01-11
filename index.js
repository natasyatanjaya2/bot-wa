/* eslint-env node */
/* global process */

import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import express from "express";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";
let forceNewQR = false;

const app = express();
app.use(express.json());

// =======================
// GLOBAL STATE
// =======================
let latestQR = null;
let sockInstance = null;
let qrTimer = null;
let isRestarting = false;
let userId = 1;

async function getOrderOnlineStatus(userId) {
  try {
    const res = await fetch(
      `https://backend-bot-wa.natasyatanjaya2.workers.dev/order-settings?user_id=${userId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          // optional kalau pakai API key
          // "x-api-key": process.env.WORKER_API_KEY
        }
      }
    );

    if (!res.ok) {
      console.error("Worker response error:", res.status);
      return false;
    }

    const data = await res.json();

    return data.order_online_enabled === true;

  } catch (err) {
    console.error("Fetch worker error:", err);
    return false;
  }
}

async function getLoadNamaToko(userId) {
  try {
    const res = await fetch(
      `https://backend-bot-wa.natasyatanjaya2.workers.dev/load-nama-toko?user_id=${userId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          // "x-api-key": process.env.WORKER_API_KEY // optional
        }
      }
    );

    if (!res.ok) {
      console.error("Worker error:", res.status);
      return "Toko";
    }

    const data = await res.json();
    return data.nama_toko;

  } catch (err) {
    console.error("Fetch nama toko error:", err);
    return "Toko";
  }
}

async function getInfoToko(userId) {
  try {
    const res = await fetch(
    `https://backend-bot-wa.natasyatanjaya2.workers.dev/info-toko?user_id=${userId}`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
          // "x-api-key": process.env.WORKER_API_KEY
        }
      }
    );

    if (!res.ok) return null;
    return await res.json();

  } catch (err) {
    console.error("Error fetch info toko:", err);
    return null;
  }
}

function intToTime(value) {
  if (value === null || value === undefined) return "00:00";

  const totalMinutes = Number(value);
  if (isNaN(totalMinutes) || totalMinutes < 0) return "00:00";

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}`;
}

async function getSettingsJamOperasional(userId) {
  try {
    const res = await fetch(
      `https://backend-bot-wa.natasyatanjaya2.workers.dev/settings-jam-operasional?user_id=${userId}`,
      {
        headers: {
          "Content-Type": "application/json"
          // "x-api-key": process.env.WORKER_API_KEY
        }
      }
    );

    if (!res.ok) return [];
    return await res.json();

  } catch (err) {
    console.error("Fetch jam operasional error:", err);
    return [];
  }
}

async function kirimMenuUtama(sock, sender, userId) {
  // ambil data dari Cloudflare Worker
  const [orderOnlineEnabled, namaToko] = await Promise.all([
    getOrderOnlineStatus(userId),
    getLoadNamaToko(userId)
  ]);

  let menuOrderOnline = "";
  if (orderOnlineEnabled) {
    menuOrderOnline =
      "7️⃣ /orderonline – Pesan produk langsung via WhatsApp\n";
  }

  const menuText = `👋 Hai! Selamat datang di *${namaToko} Bot*.
Saya siap membantu kebutuhan sparepart Anda. Silakan pilih perintah dari menu di bawah ini:

📋 *Menu Utama ${namaToko}*

Ketik perintah sesuai kebutuhan:

1️⃣ /infotoko – Info tentang toko
2️⃣ /jamoperasional – Jadwal buka toko
3️⃣ /cariproduk [kata] – Cari produk berdasarkan nama
4️⃣ /carikategori [kata] – Cari kategori tertentu
5️⃣ /carimerek [kata] – Cari merek tertentu
6️⃣ /rekomendasiproduk – Produk paling laku
${menuOrderOnline}
Contoh penggunaan:
🔍 /cariproduk filter udara
🔥 /rekomendasiproduk

📌 *Ketik /menu untuk melihat menu kapan saja*
🚀 *Ketik /start untuk memulai kembali bot ini*`;

  await sock.sendMessage(sender, { text: menuText });
}

// =======================
// QR PAGE
// =======================
app.get("/qr", async (req, res) => {
  if (!latestQR) {
    return res.send(`
      <h3>QR not available</h3>
      <p>Bot already connected or waiting for new QR.</p>
    `);
  }

  const qrImage = await QRCode.toDataURL(latestQR);

  res.send(`
    <h2>Scan WhatsApp QR</h2>
    <img src="${qrImage}" />
    <p>WhatsApp → Linked Devices → Link a Device</p>
  `);
});

// =======================
// START WHATSAPP BOT
// =======================
async function startBot() {
  console.log("🚀 Starting WhatsApp bot...");

  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" })
  });

  sockInstance = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // =======================
    // QR HANDLING + AUTO RENEW
    // =======================
    if (qr) {
      latestQR = qr;

      if (qrTimer) clearTimeout(qrTimer);

      qrTimer = setTimeout(() => {
        console.log("⏰ QR expired, regenerating...");
        try {
          sock.end(); // paksa reconnect → QR baru
        } catch (e) {}
      }, 40000); // 40 detik aman

      const host =
        process.env.PUBLIC_URL ||
        `http://localhost:${process.env.PORT || 3000}`;

      console.log("📱 Scan QR at:", `${host}/qr`);
    }

    // =======================
    // CONNECTED
    // =======================
    if (connection === "open") {
      console.log("✅ BOT WHATSAPP CONNECTED");
      latestQR = null;
      if (qrTimer) clearTimeout(qrTimer);
    }

    // =======================
    // DISCONNECTED
    // =======================
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection closed:", statusCode);
    
      // =======================
      // LOGOUT → DELETE AUTH
      // =======================
      if (statusCode === DisconnectReason.loggedOut && forceNewQR) {
        console.log("🧹 Deleting auth folder...");
    
        try {
          if (fs.existsSync("./auth")) {
            fs.rmSync("./auth", { recursive: true, force: true });
            console.log("✅ Auth folder deleted");
          }
        } catch (e) {
          console.error("Auth delete error:", e);
        }
    
        // reset state
        latestQR = null;
        forceNewQR = false;
        sockInstance = null;
    
        // ⏳ tunggu filesystem settle
        setTimeout(() => {
          console.log("🔁 Restarting bot for new QR...");
          startBot();
        }, 3000);
    
        return;
      }
    
      // =======================
      // NORMAL RECONNECT
      // =======================
      setTimeout(() => {
        console.log("🔄 Reconnecting bot...");
        startBot();
      }, 5000);
    }
  });

  // =======================
  // MESSAGE HANDLER
  // =======================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg?.message) return;

    // ✅ DEFINISIKAN sender
    const sender = msg.key.remoteJid;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (text === "/menu" || text === "/start") {
      await kirimMenuUtama(sock, sender, userId);
    }

    if (text.startsWith("/infotoko")) {
      const infoToko = await getInfoToko(userId);
    
      if (!infoToko) {
        return await sock.sendMessage(sender, {
          text: "⚠️ Info toko belum tersedia."
        });
      }
    
      const pesan =
        `*${infoToko.nama_toko}*\n` +
        `Jenis Usaha: ${infoToko.jenis_usaha}\n` +
        `Deskripsi: ${infoToko.deskripsi}\n` +
        `Alamat: ${infoToko.alamat}\n` +
        `Kontak: ${infoToko.no_telepon}`;
    
      return await sock.sendMessage(sender, { text: pesan });
    }

    if (text.startsWith("/jamoperasional")) {
      const jamOperasional = await getSettingsJamOperasional(userId);
    
      if (jamOperasional.length === 0) {
        return await sock.sendMessage(sender, {
          text: "⚠️ Jadwal operasional belum diatur."
        });
      }
    
      const daftar = jamOperasional.map(row => {
        if (row.aktif) {
          const buka = intToTime(row.jam_buka);
          const tutup = intToTime(row.jam_tutup);
          return `📅 *${row.hari}*: ${buka} - ${tutup}`;
        } else {
          return `📅 *${row.hari}*: ❌ *Tutup*`;
        }
      }).join("\n");
    
      const namaToko = await getLoadNamaToko(userId);
    
      const pesan =
        `🕐 *Jam Operasional ${namaToko}*\n` +
        `Berikut adalah jadwal buka toko:\n\n` +
        `${daftar}\n\n` +
        `📌 Jadwal dapat berubah sewaktu-waktu.`;
    
      return await sock.sendMessage(sender, { text: pesan });
    }
  });
}

// =======================
// LOGOUT + FORCE NEW QR
// =======================
app.get("/logout", async (req, res) => {
  try {
    if (!sockInstance) {
      return res.send("No active session");
    }

    console.log("🚪 Logout requested");
    forceNewQR = true;

    await sockInstance.logout(); // trigger loggedOut

    res.send("Logged out. Generating new QR...");

  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// =======================
// START BOT
// =======================
startBot();

// =======================
// API ROOT
// =======================
app.get("/", (req, res) => {
  res.json({ status: "Bot + API running" });
});

// =======================
// SERVER
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🌐 Server running on port", PORT);
});









