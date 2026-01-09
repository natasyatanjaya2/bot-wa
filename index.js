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






