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
import open from "open";

const app = express();
app.use(express.json());

// =======================
// GLOBAL STATE
// =======================
let latestQR = null;

// =======================
// MODE DETECTION
// =======================
const IS_PRODUCTION = process.env.PRODUCTION === "true";

// =======================
// QR PAGE
// =======================
app.get("/qr", async (req, res) => {
  if (!latestQR) {
    return res.send(`
      <h3>QR not available</h3>
      <p>The bot is already logged in or waiting for connection.</p>
    `);
  }

  const qrImage = await QRCode.toDataURL(latestQR);

  res.send(`
    <h2>Scan WhatsApp QR</h2>
    <img src="${qrImage}" />
    <p>Open WhatsApp → Linked Devices → Link a Device</p>
  `);
});

// =======================
// START WHATSAPP BOT
// =======================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ===== QR HANDLING (LOCAL ONLY)
    if (!IS_PRODUCTION && qr) {
      latestQR = qr;
      console.log("📱 QR available at http://localhost:3000/qr");

      // buka browser setiap QR baru (AMAN)
      open("http://localhost:3000/qr");
    }

    // ===== CONNECTED
    if (connection === "open") {
      console.log("✅ BOT WHATSAPP CONNECTED");
      latestQR = null;
    }

    // ===== DISCONNECTED
    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      console.log("❌ Connection closed:", statusCode);

      // session invalid → stop, harus scan ulang
      if (statusCode === DisconnectReason.loggedOut || statusCode === 401) {
        console.log("⚠️ Session logged out. Please scan QR again.");
        return;
      }

      // reconnect dengan delay (WAJIB)
      setTimeout(() => {
        console.log("🔄 Reconnecting bot...");
        startBot();
      }, 8000);
    }
  });

  // =======================
  // MESSAGE HANDLER (AMAN)
  // =======================
  sock.ev.on("messages.upsert", async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message) return;

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

startBot();

// =======================
// API ROOT
// =======================
app.get("/", (req, res) => {
  res.json({ status: "Bot + API running" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("🚀 Server running on port", PORT);
});
