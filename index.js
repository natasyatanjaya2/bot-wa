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

const app = express();
app.use(express.json());

// =======================
// GLOBAL STATE
// =======================
let latestQR = null;
let sockInstance = null;
let qrTimer = null;
let isRestarting = false;

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
    
      if (
        statusCode === DisconnectReason.loggedOut &&
        !isRestarting
      ) {
        isRestarting = true;
    
        console.log("🧹 Logged out detected. Reinitializing bot...");
    
        // ⛔ PENTING: matikan process socket lama
        sockInstance = null;
    
        setTimeout(() => {
          isRestarting = false;
          startBot(); // ⬅️ BARU DI SINI
        }, 3000);
    
        return;
      }
    
      // reconnect biasa (network issue)
      setTimeout(() => {
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

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      "";

    if (text.toLowerCase() === "ping") {
      await sock.sendMessage(msg.key.remoteJid, {
        text: "pong 🟢"
      });
    }
  });
}

// =======================
// LOGOUT + FORCE NEW QR
// =======================
app.get("/logout", async (req, res) => {
  try {
    if (!sockInstance) {
      return res.send("No active WhatsApp session");
    }

    console.log("🚪 Logging out WhatsApp...");

    await sockInstance.logout();

    latestQR = null;
    if (qrTimer) clearTimeout(qrTimer);

    res.send("Logged out. Restarting bot for new QR...");

    // ⛔ JANGAN startBot DI SINI
    // ⛔ JANGAN reconnect socket lama

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




