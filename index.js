/* eslint-env node */
/* global process */

import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  BufferJSON
} from "@whiskeysockets/baileys";

import express from "express";
import pino from "pino";
import QRCode from "qrcode";
import fs from "fs";
import mongoose from "mongoose";
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
let FORCE_NEW = true;

mongoose.connect(process.env.MONGO_URL)
  .then(() => {
    console.log("✅ MongoDB connected");
    startBot(); // ⬅️ pindahkan ke sini
  })
  .catch(err => console.log("❌ MongoDB error:", err));

const AuthSchema = new mongoose.Schema({
  key: String,
  value: mongoose.Schema.Types.Mixed
});

const Auth = mongoose.model("Auth", AuthSchema);

const useMongoAuthState = async () => {
  const writeData = async (data) => {
    for (const key in data) {
      await Auth.findOneAndUpdate(
        { key },
        { value: JSON.parse(JSON.stringify(data[key], BufferJSON.replacer)) },
        { upsert: true }
      );
    }
  };
  const readData = async () => {
    const docs = await Auth.find();
    const state = {};
    docs.forEach(doc => {
      state[doc.key] = JSON.parse(
        JSON.stringify(doc.value),
        BufferJSON.reviver
      );
    });
    return state;
  };
  const state = await readData();
  return {
    state: {
      creds: state.creds || {},
      keys: {
        get: (type, ids) => {
          const data = {};
          ids.forEach(id => {
            data[id] = state[`${type}-${id}`];
          });
          return data;
        },
        set: async (data) => {
          const newData = {};
          for (const type in data) {
            for (const id in data[type]) {
              newData[`${type}-${id}`] = data[type][id];
            }
          }
          await writeData(newData);
        }
      }
    },
    saveCreds: async () => {
      await writeData({ creds: state.creds });
    }
  };
};

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

async function getCariProduk(userId, keyword) {
  try {
    const res = await fetch(
      `https://backend-bot-wa.natasyatanjaya2.workers.dev/cari-produk?user_id=${userId}&q=${encodeURIComponent(keyword)}`,
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
    console.error("Cari produk error:", err);
    return [];
  }
}

async function getCariKategori(userId, keyword) {
  try {
    const res = await fetch(
      `https://backend-bot-wa.natasyatanjaya2.workers.dev/cari-kategori?user_id=${userId}&q=${encodeURIComponent(keyword)}`,
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
    console.error("Cari kategori error:", err);
    return [];
  }
}

async function getCariMerek(userId, keyword) {
  try {
    const res = await fetch(
      `https://backend-bot-wa.natasyatanjaya2.workers.dev/cari-merek?user_id=${userId}&q=${encodeURIComponent(keyword)}`,
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
    console.error("Cari merek error:", err);
    return [];
  }
}

async function getRekomendasiProduk(userId) {
  try {
    const res = await fetch(
      `https://backend-bot-wa.natasyatanjaya2.workers.dev/rekomendasi-produk?user_id=${userId}`,
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
    console.error("Rekomendasi produk error:", err);
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

  const menuText = `👋 Hai! Selamat datang di *${namaToko} Bot*  
Bot ini dibuat menggunakan *SoftwarePro*  
  
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
🚀 *Ketik /start untuk memulai kembali bot ini*  
  
*Powered by SoftwarePro*`;

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
// async function startBot() {
//   console.log("🚀 Starting WhatsApp bot...");

//   // const { state, saveCreds } = await useMultiFileAuthState("./auth");
//   // const { state, saveCreds } = await useMongoAuthState();
//   const { state, saveCreds } = await useMultiFileAuthState("temp-auth");

//   const sock = makeWASocket({
//     auth: state,
//     logger: pino({ level: "silent" })
//   });

//   sockInstance = sock;

//   sock.ev.on("creds.update", saveCreds);

//   sock.ev.on("connection.update", (update) => {
//     const { connection, lastDisconnect, qr } = update;

//     // =======================
//     // QR HANDLING + AUTO RENEW
//     // =======================
//     if (qr) {
//       latestQR = qr;

//       if (qrTimer) clearTimeout(qrTimer);

//       qrTimer = setTimeout(() => {
//         console.log("⏰ QR expired, regenerating...");
//         try {
//           sock.end(); // paksa reconnect → QR baru
//         } catch (e) {}
//       }, 40000); // 40 detik aman

//       const host =
//         process.env.PUBLIC_URL ||
//         `http://localhost:${process.env.PORT || 3000}`;

//       console.log("📱 Scan QR at:", `${host}/qr`);
//     }

//     // =======================
//     // CONNECTED
//     // =======================
//     if (connection === "open") {
//       console.log("✅ BOT WHATSAPP CONNECTED");
//       latestQR = null;
//       if (qrTimer) clearTimeout(qrTimer);
//     }

//     // =======================
//     // DISCONNECTED
//     // =======================
//     if (connection === "close") {
//       const statusCode = lastDisconnect?.error?.output?.statusCode;
//       console.log("❌ Connection closed:", statusCode);

//       // =======================
//       // LOGOUT → DELETE AUTH
//       // =======================
//       if (statusCode === DisconnectReason.loggedOut && forceNewQR) {
//         console.log("🧹 Deleting auth folder...");

//         try {
//           // if (fs.existsSync("./auth")) {
//           //   fs.rmSync("./auth", { recursive: true, force: true });
//           //   console.log("✅ Auth folder deleted");
//           // }
//         } catch (e) {
//           console.error("Auth delete error:", e);
//         }

//         // reset state
//         latestQR = null;
//         forceNewQR = false;
//         sockInstance = null;

//         // ⏳ tunggu filesystem settle
//         setTimeout(() => {
//           console.log("🔁 Restarting bot for new QR...");
//           startBot();
//         }, 3000);

//         return;
//       }

//       // =======================
//       // NORMAL RECONNECT
//       // =======================
//       setTimeout(() => {
//         console.log("🔄 Reconnecting bot...");
//         startBot();
//       }, 5000);
//     }
//   });

//   // =======================
//   // MESSAGE HANDLER
//   // =======================
//   sock.ev.on("messages.upsert", async ({ messages }) => {
//     const msg = messages[0];
//     if (!msg?.message) return;

//     // ✅ DEFINISIKAN sender
//     const sender = msg.key.remoteJid;

//     const text =
//       msg.message.conversation ||
//       msg.message.extendedTextMessage?.text ||
//       "";

//     const isi = text.toLowerCase().trim();

//     const greetingRegex = /\b(hi|hello|hai|halo|permisi)\b/;

//     // menu command
//     const isMenuCommand = isi === "/menu" || isi === "/start";

//     // greeting:
//     // - mengandung kata greeting
//     // - bukan command
//     // - pesan pendek (anti loop)
//     const isGreeting =
//       greetingRegex.test(isi) &&
//       !isi.startsWith("/") &&
//       isi.length <= 20;

//     if (isMenuCommand || isGreeting) {
//       await kirimMenuUtama(sock, sender, userId);
//       return;
//     }

//     if (text.startsWith("/infotoko")) {
//       const infoToko = await getInfoToko(userId);

//       if (!infoToko) {
//         return await sock.sendMessage(sender, {
//           text: "⚠️ Info toko belum tersedia."
//         });
//       }

//       const pesan =
//         `*${infoToko.nama_toko}*\n` +
//         `Jenis Usaha: ${infoToko.jenis_usaha}\n` +
//         `Deskripsi: ${infoToko.deskripsi}\n` +
//         `Alamat: ${infoToko.alamat}\n` +
//         `Kontak: ${infoToko.no_telepon}`;

//       return await sock.sendMessage(sender, { text: pesan });
//     }

//     if (text.startsWith("/jamoperasional")) {
//       const jamOperasional = await getSettingsJamOperasional(userId);

//       if (jamOperasional.length === 0) {
//         return await sock.sendMessage(sender, {
//           text: "⚠️ Jadwal operasional belum diatur."
//         });
//       }

//       const daftar = jamOperasional.map(row => {
//         if (row.aktif) {
//           const buka = intToTime(row.jam_buka);
//           const tutup = intToTime(row.jam_tutup);
//           return `📅 *${row.hari}*: ${buka} - ${tutup}`;
//         } else {
//           return `📅 *${row.hari}*: ❌ *Tutup*`;
//         }
//       }).join("\n");

//       const namaToko = await getLoadNamaToko(userId);

//       const pesan =
//         `🕐 *Jam Operasional ${namaToko}*\n` +
//         `Berikut adalah jadwal buka toko:\n\n` +
//         `${daftar}\n\n` +
//         `📌 Jadwal dapat berubah sewaktu-waktu.`;

//       return await sock.sendMessage(sender, { text: pesan });
//     }

//     if (text.startsWith("/cariproduk")) {
//       const kata = text.replace("/cariproduk", "").trim().toLowerCase();

//       if (!kata) {
//         return await sock.sendMessage(sender, {
//           text: "🔍 Contoh: /cariproduk oli"
//         });
//       }

//       const produk = await getCariProduk(userId, kata);

//       if (produk.length === 0) {
//         return await sock.sendMessage(sender, {
//           text: `🔍 Produk dengan kata "${kata}" tidak ditemukan.`
//         });
//       }

//       const daftar = produk.map((p, i) =>
//         `${i + 1}. *${p.nama}*\n` +
//         `Kategori: ${p.kategori}\n` +
//         `Merek: ${p.merek}\n` +
//         `Stok: ${p.stok}\n` +
//         `Harga: ${Number(p.harga_jual).toLocaleString()}`
//       ).join("\n\n");

//       const pesan =
//         `🔍 *Hasil Pencarian Produk: "${kata}" (${produk.length} ditemukan)*\n\n` +
//         daftar;

//       return await sock.sendMessage(sender, { text: pesan });
//     }

//     if (text.startsWith("/carikategori")) {
//       const kata = text.replace("/carikategori", "").trim().toLowerCase();

//       if (!kata) {
//         return await sock.sendMessage(sender, {
//           text: "📂 Contoh: /carikategori oli"
//         });
//       }

//       const kategori = await getCariKategori(userId, kata);

//       if (kategori.length === 0) {
//         return await sock.sendMessage(sender, {
//           text: `🔍 Kategori dengan kata "${kata}" tidak ditemukan.`
//         });
//       }

//       const daftar = kategori
//         .map((k, i) => `${i + 1}. ${k.nama}`)
//         .join("\n");

//       const pesan =
//         `📂 *Hasil Pencarian Kategori: "${kata}" (${kategori.length} ditemukan)*\n\n` +
//         daftar;

//       return await sock.sendMessage(sender, { text: pesan });
//     }

//     if (text.startsWith("/carimerek")) {
//       const kata = text.replace("/carimerek", "").trim().toLowerCase();

//       if (!kata) {
//         return await sock.sendMessage(sender, {
//           text: "🏷️ Contoh: /carimerek honda"
//         });
//       }

//       const merek = await getCariMerek(userId, kata);

//       if (merek.length === 0) {
//         return await sock.sendMessage(sender, {
//           text: `🔍 Merek dengan kata "${kata}" tidak ditemukan.`
//         });
//       }

//       const daftar = merek
//         .map((m, i) => `${i + 1}. ${m.nama}`)
//         .join("\n");

//       const pesan =
//         `🏷️ *Hasil Pencarian Merek: "${kata}" (${merek.length} ditemukan)*\n\n` +
//         daftar;

//       return await sock.sendMessage(sender, { text: pesan });
//     }

//     if (text.startsWith("/rekomendasiproduk")) {
//       const produk = await getRekomendasiProduk(userId);

//       if (produk.length === 0) {
//         return await sock.sendMessage(sender, {
//           text: "❌ Belum ada data pembelian bulan ini."
//         });
//       }

//       let pesan = produk.length < 3
//         ? `📊 *Hanya ${produk.length} produk terjual bulan ini*\n\n`
//         : `🔥 *10 Produk Terlaris Bulan Ini*\n\n`;

//       pesan += produk.map((p, i) =>
//         `${i + 1}. *${p.nama}*\n` +
//         `Terjual: ${p.total_terjual}x\n` +
//         `Stok: ${p.stok} | ${p.kategori} • ${p.merek}\n` +
//         `Harga: ${Number(p.harga_jual).toLocaleString()}\n`
//       ).join("\n\n");

//       return await sock.sendMessage(sender, { text: pesan });
//     }
//   });
// }
async function startBot() {
  console.log("🚀 Starting WhatsApp bot...");

  let state, saveCreds;

  if (FORCE_NEW) {
    console.log("🧨 FORCE NEW SESSION (NO AUTH)");

    state = {
      creds: {},
      keys: {
        get: () => ({}),
        set: async () => { }
      }
    };

    saveCreds = async () => { };
  } else {
    const mongo = await useMongoAuthState();
    state = mongo.state;
    saveCreds = mongo.saveCreds;
  }

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    browser: ["Render Bot", "Chrome", "1.0.0"],
    printQRInTerminal: true
  });

  sockInstance = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    console.log("DEBUG UPDATE:", update);
    const { connection, qr } = update;

    if (qr) {
      console.log("📱 QR READY!");
      latestQR = qr;
    }

    if (connection === "open") {
      console.log("✅ CONNECTED");
      FORCE_NEW = false; // setelah login, pakai MongoDB lagi
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

app.get("/test", (req, res) => {
  res.send("TEST OK");
});

app.get("/reset", async (req, res) => {
  try {
    console.log("🧹 FORCE RESET TOTAL");

    // 1. Hapus session DB
    await Auth.deleteMany({});

    // 2. Kill socket
    if (sockInstance) {
      try {
        await sockInstance.logout();
        sockInstance.end();
      } catch (e) { }
    }

    // 3. Reset semua state
    latestQR = null;
    sockInstance = null;

    res.send("✅ Reset total, bot restart...");

    // 4. Restart bot dari nol
    setTimeout(() => {
      startBot();
    }, 3000);

  } catch (e) {
    console.error(e);
    res.send("❌ Reset gagal");
  }
});