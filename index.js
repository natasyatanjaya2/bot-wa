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

// =======================
// ENV DETECTION (AMAN)
// =======================
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// =======================
// QR PAGE
// =======================
app.get("/qr", async (req, res) => {
  if (!latestQR) {
    return res.send(`
      <h3>QR not available</h3>
      <p>Bot already connected or waiting for reconnection.</p>
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
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" })
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    // ===== QR HANDLING
    if (qr) {
      latestQR = qr;

      const host =
        process.env.PUBLIC_URL ||
        `http://localhost:${process.env.PORT || 3000}`;

      console.log("📱 Scan QR at:", `${host}/qr`);
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

      if (
        statusCode === DisconnectReason.loggedOut ||
        statusCode === 401
      ) {
        console.log("⚠️ Logged out. Delete auth folder and scan QR again.");
        return;
      }

      setTimeout(() => {
        console.log("🔄 Reconnecting bot...");
        startBot();
      }, 8000);
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
