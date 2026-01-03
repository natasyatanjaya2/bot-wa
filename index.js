import { makeWASocket, useMultiFileAuthState, downloadContentFromMessage, downloadMediaMessage } from '@whiskeysockets/baileys';
import express from 'express';
import qrcode from 'qrcode';
import fs from 'fs';
import mysql from 'mysql2/promise';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { Buffer } from 'buffer';

let isConnected = false;
let db;
let namaToko = "Toko";
let sock = null;
// Struktur penyimpanan sesi: key = nomor, value = { ref_no, tahap }
let sesiPengguna = {}; // Simpan sesi aktif per nomor
let sesi = {};
const userStates = {};
const pendingKonfirmasiProduk = {};
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function kirimPesanKeWhatsApp(nomor, pesan) {
    if (!sock) {
        throw new Error("Belum terhubung ke WhatsApp.");
    }

    let nomorWA = nomor.replace(/\D/g, '');
    if (nomorWA.startsWith('0')) {
        nomorWA = '62' + nomorWA.slice(1); // Ganti 0 dengan 62
    }
    nomorWA += '@s.whatsapp.net';

    try {
        await sock.sendMessage(nomorWA, { text: pesan });
        console.log(`✅ Pesan berhasil dikirim ke ${nomor}`);
    } catch (err) {
        console.error(`❌ Gagal kirim ke ${nomor}:`, err);
        throw new Error("Gagal kirim pesan.");
    }
}

export default {
    kirimPesanKeWhatsApp, downloadMediaMessage
};

const start = async () => {
    db = await mysql.createConnection({
        host: '127.0.0.1',
        user: 'user_program',
        password: 'mysql',
        database: 'program_toko',
        port: 3307
    });

    const { state, saveCreds } = await useMultiFileAuthState('./auth');
    sock = makeWASocket({ auth: state });

    await loadNamaToko(db);
    sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            const qrImage = await qrcode.toDataURL(qr);
            fs.writeFileSync('./qr.html', `
            <html><head><title>Scan QR WhatsApp</title></head>
            <body><h2>Scan QR:</h2><img src="${qrImage}" /></body></html>`);
            exec('start http://localhost:3000/qr') // Windows
        }

        if (connection === "open") {
            const fullId = sock.user?.id || 'unknown@s.whatsapp.net';
            const userId = fullId.split('@')[0].replace(':', '-'); // sekarang aman
            const nomorPath = path.join(__dirname, 'auth', userId, 'nomor.txt');

            const nomorFolder = path.join(__dirname, 'auth', userId);
            if (!fs.existsSync(nomorFolder)) {
                fs.mkdirSync(nomorFolder, { recursive: true });
            }

            // Cek apakah nomor lama tersimpan
            if (fs.existsSync(nomorPath)) {
                const savedNumber = fs.readFileSync(nomorPath, 'utf-8');
                console.log("📱 Nomor WA sebelumnya:", savedNumber);
            }

            // Simpan nomor baru (tanpa domain)
            fs.writeFileSync(nomorPath, userId);

            console.log(`✅ Bot terhubung ke WhatsApp (${userId})`);
            isConnected = true;
        }
        else if (connection === "close") {
            console.log("❌ Bot terputus");

            const statusCode = lastDisconnect?.error?.output?.statusCode;

            // JANGAN auto reconnect kalau conflict / device_removed
            if (statusCode === 401) {
                console.log("⚠️ Session invalid / device removed. Harus scan ulang.");
                return;
            }

            // Delay reconnect (WAJIB)
            setTimeout(() => {
                console.log("🔄 Reconnecting bot...");
                start();
            }, 8000); // minimal 5–10 detik
        }
    });

    async function loadNamaToko(db) {
        const [rows] = await db.execute(`SELECT nama_toko FROM settings_toko LIMIT 1`);
        if (rows.length > 0) {
            namaToko = rows[0].nama_toko;
        }
    }

    sock.ev.on('creds.update', saveCreds);

    async function getOrderOnlineStatus() {
        const [rows] = await db.query(`
        SELECT setting_value 
        FROM order_settings 
        WHERE setting_key='order_online_enabled'
        LIMIT 1
    `);

        if (rows.length === 0) return false;

        return rows[0].setting_value == 1 || rows[0].setting_value == "1";
    }

    async function kirimMenuUtama(sock, sender) {
        const orderOnlineEnabled = await getOrderOnlineStatus(); // true/false

        let menuOrderOnline = "";
        if (orderOnlineEnabled) {
            menuOrderOnline = "🔟 /orderonline – Pesan produk langsung via WhatsApp\n";
        }

        const menuText = `👋 Hai! Selamat datang di *${namaToko} Bot*.
Saya siap membantu kebutuhan sparepart Anda. Silakan pilih perintah dari menu di bawah ini:

📋 *Menu Utama ${namaToko}*

Ketik perintah sesuai kebutuhan:

1️⃣ /infotoko – Info tentang toko
2️⃣ /jamoperasional – Jadwal buka toko
3️⃣ /daftarproduk – Menampilkan semua produk
4️⃣ /daftarkategori – Menampilkan semua kategori
5️⃣ /daftarmerek – Menampilkan semua merek
6️⃣ /cariproduk [kata] – Cari produk berdasarkan nama
7️⃣ /carikategori [kata] – Cari kategori tertentu
8️⃣ /carimerek [kata] – Cari merek tertentu
9️⃣ /rekomendasiproduk – Produk paling laku
${menuOrderOnline}
Contoh penggunaan:
🔍 /cariproduk filter udara
🔥 /rekomendasiproduk

📌 *Ketik /menu untuk melihat menu kapan saja*
🚀 *Ketik /start untuk memulai kembali bot ini*`;

        await sock.sendMessage(sender, { text: menuText });
    }

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        let sender = msg.key.remoteJid;
        if (!sender || sender === 'status@broadcast') return;

        const isiPesan = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const nomor = sender.replace('@s.whatsapp.net', '');
        sesi = sesiPengguna[nomor];

        if (!userStates[sender]) userStates[sender] = { sudahSapa: false };

        // Kirim sapaan awal dan menu
        if (!userStates[sender].sudahSapa) {
            try {
                await kirimMenuUtama(sock, sender);
                userStates[sender].sudahSapa = true;
            } catch (err) {
                console.error('❌ Gagal kirim menu:', err);
            }
            return;
        }

        if (isiPesan === '/menu' || isiPesan === '/start') {
            try {
                await kirimMenuUtama(sock, sender);
            } catch (err) {
                console.error('❌ Gagal kirim menu:', err);
            }
        }

        if (isiPesan.startsWith("/infotoko")) {
            const [rows] = await db.execute(`
        SELECT nama_toko, jenis_usaha, deskripsi, alamat, no_telepon 
        FROM settings_toko 
        LIMIT 1
    `);

            if (rows.length > 0) {
                const toko = rows[0];
                const pesan = `*${toko.nama_toko}*\n` +
                    `Jenis Usaha: ${toko.jenis_usaha}\n` +
                    `Deskripsi: ${toko.deskripsi}\n` +
                    `Alamat: ${toko.alamat}\n` +
                    `Kontak: ${toko.no_telepon}`;

                return await sock.sendMessage(sender, { text: pesan });
            } else {
                return await sock.sendMessage(sender, { text: "⚠️ Info toko belum tersedia di database." });
            }
        }

        if (isiPesan.startsWith("/jamoperasional")) {
            const [rows] = await db.execute(`SELECT hari, jam_buka, jam_tutup, aktif FROM settings_jam_operasional`);

            const daftar = rows.map(row => {
                if (row.aktif) {
                    const buka = row.jam_buka.slice(0, 5);
                    const tutup = row.jam_tutup.slice(0, 5);
                    return `📅 *${row.hari}*: ${buka} - ${tutup}`;
                } else {
                    return `📅 *${row.hari}*: ❌ *Tutup*`;
                }
            }).join("\n");

            const pesan = `🕐 *Jam Operasional ${namaToko}*\n` +
                `Berikut adalah jadwal buka toko:\n\n${daftar}\n\n` +
                `📌 Jadwal dapat berubah sewaktu-waktu.`;

            return await sock.sendMessage(sender, { text: pesan });
        }

        if (isiPesan.startsWith("/daftarproduk")) {
            const [countRows] = await db.execute(`SELECT COUNT(*) as total FROM produk`);
            const totalProduk = countRows[0].total;

            const [rows] = await db.execute(`
        SELECT 
            p.nama, p.stok, p.harga_beli, p.harga_jual, p.harga_jual_2, p.harga_dus,
            k.nama AS kategori, m.nama AS merek
        FROM produk p
        JOIN kategori k ON p.kategori_id = k.id
        JOIN merk m ON p.merk_id = m.id
        ORDER BY p.id ASC
        LIMIT 100
    `); // ✅ batasi 100

            if (rows.length === 0) {
                return await sock.sendMessage(sender, { text: "❌ Tidak ada produk ditemukan." });
            }

            const daftar = rows.map((p, i) =>
                `${i + 1}. *${p.nama}*\n📦 Stok: ${p.stok} | Merek: ${p.merek} | Kategori: ${p.kategori}` +
                `\n💰 Harga 1: ${p.harga_jual.toLocaleString()}` +
                `\n💰 Harga 2: ${p.harga_jual_2.toLocaleString()}` +
                `\n📦 Harga Dus: ${p.harga_dus.toLocaleString()}`
            ).join("\n\n");

            const pesan = `📦 *Daftar Produk (${totalProduk})*\n\n${daftar}`;

            return await sock.sendMessage(sender, { text: pesan });
        }

        if (isiPesan.startsWith("/daftarkategori")) {
            const limit = 100;

            const [countRows] = await db.execute(`SELECT COUNT(*) as total FROM kategori`);
            const totalKategori = countRows[0].total;

            const [rows] = await db.execute(`SELECT nama FROM kategori ORDER BY nama ASC LIMIT ?`, [limit]);

            if (rows.length === 0) {
                return await sock.sendMessage(sender, { text: "❌ Tidak ada kategori ditemukan." });
            }

            const daftar = rows.map((k, i) => `${i + 1}. ${k.nama}`).join("\n");

            const pesan = `📂 *Daftar Kategori (${totalKategori})*\n\n${daftar}`;

            return await sock.sendMessage(sender, { text: pesan });
        }

        if (isiPesan.startsWith("/daftarmerek")) {
            const limit = 100;

            const [countRows] = await db.execute(`SELECT COUNT(*) as total FROM merk`);
            const totalMerek = countRows[0].total;

            const [rows] = await db.execute(`SELECT nama FROM merk ORDER BY nama ASC LIMIT ?`, [limit]);

            if (rows.length === 0) {
                return await sock.sendMessage(sender, { text: "❌ Tidak ada merek ditemukan." });
            }

            const daftar = rows.map((m, i) => `${i + 1}. ${m.nama}`).join("\n");

            const pesan = `🏷️ *Daftar Merek (${totalMerek})*\n\n${daftar}`;

            return await sock.sendMessage(sender, { text: pesan });
        }

        if (isiPesan.startsWith("/cariproduk")) {
            const kata = isiPesan.replace("/cariproduk", "").trim().toLowerCase();

            const [rows] = await db.execute(`
        SELECT 
            p.nama, p.stok,
            p.harga_jual, p.harga_jual_2, p.harga_dus,
            k.nama AS kategori, m.nama AS merek
        FROM produk p
        JOIN kategori k ON p.kategori_id = k.id
        JOIN merk m ON p.merk_id = m.id
        WHERE LOWER(p.nama) LIKE ?
        ORDER BY p.nama ASC
        LIMIT 100
    `, [`%${kata}%`]);

            if (rows.length === 0) {
                return await sock.sendMessage(sender, { text: `🔍 Produk dengan kata "${kata}" tidak ditemukan.` });
            }

            const daftar = rows.map((p, i) =>
                `${i + 1}. *${p.nama}*\n` +
                `📦 Stok: ${p.stok} | ${p.kategori} • ${p.merek}\n` +
                `💰 Harga 1: ${p.harga_jual.toLocaleString()}\n` +
                `💰 Harga 2: ${p.harga_jual_2.toLocaleString()}\n` +
                `📦 Harga Dus: ${p.harga_dus.toLocaleString()}`
            ).join("\n\n");

            const pesan = `🔍 *Hasil Pencarian Produk: "${kata}" (${rows.length} ditemukan)*\n\n${daftar}`;

            return await sock.sendMessage(sender, { text: pesan });
        }

        if (isiPesan.startsWith("/carikategori")) {
            const kata = isiPesan.replace("/carikategori", "").trim().toLowerCase();

            const [rows] = await db.execute(`
        SELECT nama FROM kategori
        WHERE LOWER(nama) LIKE ?
        ORDER BY nama ASC
        LIMIT 100
    `, [`%${kata}%`]);

            if (rows.length === 0) {
                return await sock.sendMessage(sender, { text: `🔍 Kategori dengan kata "${kata}" tidak ditemukan.` });
            }

            const daftar = rows.map((k, i) => `${i + 1}. ${k.nama}`).join("\n");

            const pesan = `📂 *Hasil Pencarian Kategori: "${kata}" (${rows.length} ditemukan)*\n\n${daftar}`;

            return await sock.sendMessage(sender, { text: pesan });
        }

        if (isiPesan.startsWith("/carimerek")) {
            const kata = isiPesan.replace("/carimerek", "").trim().toLowerCase();

            const [rows] = await db.execute(`
        SELECT nama FROM merk
        WHERE LOWER(nama) LIKE ?
        ORDER BY nama ASC
        LIMIT 100
    `, [`%${kata}%`]);

            if (rows.length === 0) {
                return await sock.sendMessage(sender, { text: `🔍 Merek dengan kata "${kata}" tidak ditemukan.` });
            }

            const daftar = rows.map((m, i) => `${i + 1}. ${m.nama}`).join("\n");

            const pesan = `🏷️ *Hasil Pencarian Merek: "${kata}" (${rows.length} ditemukan)*\n\n${daftar}`;

            return await sock.sendMessage(sender, { text: pesan });
        }

        if (isiPesan.startsWith("/rekomendasiproduk")) {
            const [rows] = await db.execute(`
        SELECT 
            p.nama, p.stok,
            p.harga_jual, p.harga_jual_2, p.harga_dus,
            k.nama AS kategori, m.nama AS merek,
            SUM(dp.jumlah) AS total_terjual
        FROM pembelian pb
        JOIN detail_pembelian dp ON pb.id = dp.pembelian_id
        JOIN produk p ON dp.produk_id = p.id
        JOIN kategori k ON p.kategori_id = k.id
        JOIN merk m ON p.merk_id = m.id
        WHERE MONTH(pb.tanggal) = MONTH(CURRENT_DATE())
          AND YEAR(pb.tanggal) = YEAR(CURRENT_DATE())
        GROUP BY dp.produk_id
        ORDER BY total_terjual DESC
        LIMIT 10
    `);

            if (rows.length === 0) {
                return await sock.sendMessage(sender, {
                    text: "❌ Belum ada data pembelian bulan ini untuk ditampilkan."
                });
            }

            let pesan = "";
            if (rows.length < 3) {
                pesan += `📊 *Hanya ${rows.length} produk terjual bulan ini*\n\n`;
            } else {
                pesan += `🔥 *10 Produk Terlaris Bulan Ini*\n\n`;
            }

            pesan += rows.map((p, i) =>
                `${i + 1}. *${p.nama}*\n` +
                `🔥 Terjual: ${p.total_terjual}x\n` +
                `📦 Stok: ${p.stok} | ${p.kategori} • ${p.merek}\n` +
                `💰 Harga 1: ${p.harga_jual.toLocaleString()}\n` +
                `💰 Harga 2: ${p.harga_jual_2.toLocaleString()}\n` +
                `📦 Harga Dus: ${p.harga_dus.toLocaleString()}`
            ).join("\n\n");

            return await sock.sendMessage(sender, { text: pesan });
        }

        // Jika pesan berupa gambar → anggap sebagai bukti transfer
        if (msg.message?.imageMessage) {
            try {
                console.log(`📩 Gambar diterima dari ${nomor}`);

                const imageMsg = msg.message.imageMessage;
                const nomorBersih = normalisasiNomor(nomor);

                // Validasi dasar media
                if (!imageMsg.mimetype) {
                    console.error("❌ Gagal: pesan tidak berisi media image yang valid.");
                    return;
                }

                // ✅ Download buffer gambar dengan auto-detect
                const buffer = await downloadMediaMessage(msg.message);

                if (!buffer || buffer.length === 0) {
                    console.error("❌ Buffer media kosong, tidak bisa menyimpan file.");
                    return;
                }

                // Pastikan folder uploads ada
                if (!fs.existsSync('./uploads')) {
                    fs.mkdirSync('./uploads', { recursive: true });
                }

                // Simpan file bukti transfer dengan nama unik
                const fileName = `bukti_${Date.now()}.jpg`;
                const filePath = `./uploads/${fileName}`;
                fs.writeFileSync(filePath, buffer);

                const [result] = await db.execute(
                    `
    UPDATE pesanan_online 
    SET bukti_transfer = ?
    WHERE no_hp = ? 
      AND status_order = 'Menunggu Pembayaran'
    `,
                    [fileName, nomorBersih]
                );

                // Cek apakah update berhasil
                if (result.affectedRows > 0) {
                    console.log(`✅ Bukti transfer tersimpan: ${filePath}`);
                    await kirimPesanKeWhatsApp(
                        nomorBersih,
                        "Bukti pembayaran sudah kami terima, menunggu konfirmasi admin 🙏"
                    );
                } else {
                    console.log(`⚠️ Bukti transfer tidak disimpan karena status pesanan bukan 'Menunggu Pembayaran'`);
                    await kirimPesanKeWhatsApp(
                        nomorBersih,
                        "Bukti pembayaran tidak bisa disimpan, karena pesanan kamu sudah diproses atau selesai."
                    );
                }
            } catch (err) {
                console.error("❌ Gagal memproses bukti transfer:", err);
                await kirimPesanKeWhatsApp(
                    nomor,
                    "⚠️ Gagal memproses bukti pembayaran, silakan kirim ulang fotonya 🙏"
                );
            }

            // Hentikan proses berikutnya (agar tidak bentrok dengan logika lain)
            return;
        }

        if (isiPesan.startsWith("/orderonline")) {

            // Cek status order online
            const orderOnlineEnabled = await getOrderOnlineStatus();

            if (!orderOnlineEnabled) {
                return await sock.sendMessage(sender, {
                    text: `⚠️ *Order Online sedang dinonaktifkan.*\n\n` +
                        `Silakan gunakan menu lain atau hubungi admin untuk pemesanan.`
                });
            }

            // Jika aktif → kirim form pemesanan
            const pesan =
                `Formulir Order Online - ${namaToko}\n\n` +
                `Silakan isi detail berikut ini untuk melakukan pemesanan:\n\n` +
                `Nama :\n` +
                `Alamat Pengiriman :\n` +
                `No HP :\n\n` +
                `Daftar Produk yang Dipesan:\n` +
                `- Nama Produk 1 (Jumlah)\n` +
                `- Nama Produk 2 (Jumlah)\n` +
                `- Nama Produk 3 (Jumlah)\n\n` +
                `Catatan Tambahan :\n\n` +
                `📞 Jika Anda kesulitan mengisi format ini, Anda juga bisa langsung *hubungi admin* untuk pemesanan manual.\n` +
                `Terima kasih 🙏`;

            return await sock.sendMessage(sender, { text: pesan });
        }

        // ✅ 1. Jika user sedang dalam sesi konfirmasi produk ambigu
        if (pendingKonfirmasiProduk[sender]) {
            await prosesKonfirmasiProdukAmbigu(sender, isiPesan);
            return;
        }

        // 1️⃣ Deteksi jika user membalas dengan isi form
        if (isiPesan.includes("Daftar Produk yang Dipesan")) {
            await prosesPesananBaru(sender, isiPesan);
            return;
        }

        // 3️⃣ Jika user sedang berada di tahap sesi lain (contoh: pilih metode pembayaran)
        if (sesi) {
            await prosesInputPilihan(sender, isiPesan);
            return;
        }

    });

    /**
     * Mengunduh media (gambar, video, dokumen, audio, dsb) dari pesan WhatsApp
     * @param {Object} msg - pesan WhatsApp (contohnya msg.message.imageMessage)
     * @param {String} type - jenis file: 'image', 'video', 'audio', 'document'
     * @param {String} filePath - lokasi penyimpanan file hasil unduhan
     * @returns {Promise<Buffer>} buffer hasil unduhan
     */
    async function downloadMediaMessage(msg, filePath = null) {
        try {
            // Cari tipe media yang ada di dalam pesan
            const messageType = Object.keys(msg).find(k => k.includes('Message'));

            if (!messageType) {
                throw new Error('Pesan tidak mengandung media apapun');
            }

            // Tentukan tipe konten (image, video, audio, document)
            const mediaType = messageType.replace('Message', '');
            const stream = await downloadContentFromMessage(msg[messageType], mediaType);

            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }

            // Jika ingin disimpan ke file
            if (filePath) {
                fs.writeFileSync(filePath, buffer);
            }

            return buffer;

        } catch (error) {
            console.error('Gagal download media:', error);
            throw error;
        }
    }

    async function prosesPesananBaru(sender, isiPesan) {
        try {
            const { nama, alamat, no_hp, daftarProduk, catatan } = parseOrderMessage(isiPesan);
            const jumlah_produk = daftarProduk.length;
            const ref_no = await generateRefNo();

            const [result] = await db.execute(
                `INSERT INTO pesanan_online (ref_no, nama, alamat_pengiriman, no_hp, jumlah_produk, catatan_tambahan, status_order, tanggal_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
                [ref_no, nama, alamat, no_hp, jumlah_produk, catatan, 'Pending']
            );

            const idPesanan = result.insertId;
            const daftarAmbigu = [];

            for (let item of daftarProduk) {
                if (!item.nama || !item.jumlah) continue;

                const namaProduk = item.nama.toLowerCase();
                const jumlah = item.jumlah;

                const [rows] = await db.execute(
                    `SELECT id, nama, harga_jual FROM produk WHERE LOWER(nama) LIKE ?`,
                    [`%${namaProduk}%`]
                );

                if (rows.length === 1) {
                    const produk = rows[0];
                    const subtotal = (produk.harga_jual || 0) * jumlah;

                    await db.execute(
                        `INSERT INTO detail_pesanan_online 
                     (pesanan_online_id, produk_id, tipe_harga, jumlah, subtotal)
                     VALUES (?, ?, 'Harga Jual 1', ?, ?)`,
                        [idPesanan, produk.id, jumlah, subtotal]
                    );

                } else if (rows.length > 1) {
                    daftarAmbigu.push({
                        namaUser: item.nama,
                        jumlah,
                        opsi: rows.map(r => ({
                            nama: r.nama,
                            harga: r.harga_jual || 0
                        })),
                        status: "pending"
                    });
                } else {
                    await sock.sendMessage(sender, {
                        text: `❌ Produk *${item.nama}* tidak ditemukan di database.`
                    });
                }
            }

            if (daftarAmbigu.length > 0) {
                pendingKonfirmasiProduk[sender] = {
                    idPesanan,
                    daftarProduk: daftarAmbigu
                };

                const produkPertama = daftarAmbigu[0];
                let teks = `Produk *${produkPertama.namaUser}* terlalu umum, ada beberapa pilihan:\n\n`;
                produkPertama.opsi.forEach((o, i) => {
                    teks += `${i + 1}️⃣ ${o.nama} – Rp${o.harga.toLocaleString("id-ID")}\n`;
                });
                teks += `\nKetik angka pilihan Anda (1–${produkPertama.opsi.length}) untuk melanjutkan.`;

                await sock.sendMessage(sender, { text: teks });
                return;
            }

            await sock.sendMessage(sender, {
                text: `✅ Terima kasih *${nama}*, pesanan Anda sudah kami terima.\n` +
                    `Jumlah produk: *${jumlah_produk}*\nStatus: *Pending*\nKami akan segera menghubungi Anda. 🙏`
            });

        } catch (err) {
            console.error("❌ Gagal parsing/simpan order:", err);
            await sock.sendMessage(sender, {
                text: `⚠️ Maaf, format order tidak bisa dibaca.\n\n` +
                    `Pastikan Anda mengikuti contoh yang benar saat mengetik /orderonline.\n\n` +
                    `📞 Jika masih kesulitan, silakan hubungi admin untuk pemesanan manual.`
            });
        }
    }

    function parseOrderMessage(isiPesan) {
        const lines = isiPesan.split("\n").map(line => line.trim());

        let nama = "", alamat = "", no_hp = "", catatan = "";
        let daftarProduk = [];
        let parsingProduk = false;

        for (let line of lines) {
            if (line.toLowerCase().startsWith("nama")) {
                nama = line.split(":")[1]?.trim() || "";
            } else if (line.toLowerCase().startsWith("alamat")) {
                alamat = line.split(":")[1]?.trim() || "";
            } else if (line.toLowerCase().startsWith("no hp")) {
                no_hp = line.split(":")[1]?.trim() || "";
            } else if (line.toLowerCase().includes("daftar produk")) {
                parsingProduk = true;
            } else if (line.toLowerCase().startsWith("catatan")) {
                parsingProduk = false;
                catatan = line.split(":")[1]?.trim() || "";
            } else if (parsingProduk && line.startsWith("-")) {
                const match = line.match(/- (.+?)\s*\((\d+)\)/);
                if (match) {
                    daftarProduk.push({
                        nama: match[1].trim(),
                        jumlah: parseInt(match[2])
                    });
                }
            }
        }

        return {
            nama,
            alamat,
            no_hp,
            daftarProduk,
            catatan
        };
    }

    async function prosesKonfirmasiProdukAmbigu(nomor, isiPesan) {
        const data = pendingKonfirmasiProduk[nomor];
        const daftar = data.daftarProduk;
        const produkSedangDiproses = daftar.find(p => p.status === "pending");
        const pilihan = parseInt(isiPesan);

        if (!produkSedangDiproses) {
            delete pendingKonfirmasiProduk[nomor];
            await sock.sendMessage(nomor + "@s.whatsapp.net", { text: "✅ Semua produk telah dikonfirmasi." });
            return;
        }

        if (!isNaN(pilihan) && pilihan >= 1 && pilihan <= produkSedangDiproses.opsi.length) {
            const produkDipilih = produkSedangDiproses.opsi[pilihan - 1];
            const idProduk = await getProdukIdByNama(produkDipilih.nama);
            const jumlah = produkSedangDiproses.jumlah;
            const subtotal = jumlah * produkDipilih.harga;

            await db.execute(`
            INSERT INTO detail_pesanan_online
            (pesanan_online_id, produk_id, jumlah, tipe_harga, subtotal)
            VALUES (?, ?, ?, 'Harga Jual 1', ?)`,
                [data.idPesanan, idProduk, jumlah, subtotal]
            );

            produkSedangDiproses.status = "selesai";

            await sock.sendMessage(nomor + "@s.whatsapp.net", {
                text: `✅ Produk *${produkDipilih.nama}* telah dicatat sebanyak *${jumlah}* pcs.`
            });

            const berikutnya = daftar.find(p => p.status === "pending");

            if (berikutnya) {
                let teks = `Produk *${berikutnya.namaUser}* terlalu umum, ada beberapa pilihan:\n\n`;
                berikutnya.opsi.forEach((o, i) => {
                    teks += `${i + 1}️⃣ ${o.nama} – Rp${o.harga.toLocaleString("id-ID")}\n`;
                });
                teks += `\nKetik angka pilihan Anda (1–${berikutnya.opsi.length}) untuk melanjutkan.`;

                await sock.sendMessage(nomor + "@s.whatsapp.net", { text: teks });
            } else {
                delete pendingKonfirmasiProduk[nomor];
                await sock.sendMessage(nomor + "@s.whatsapp.net", {
                    text: `✅ Semua produk telah dikonfirmasi. Terima kasih 🙏`
                });
            }

        } else {
            await sock.sendMessage(nomor + "@s.whatsapp.net", {
                text: `❌ Pilihan tidak valid. Ketik angka sesuai daftar yang dikirim.`
            });
        }
    }

    async function prosesInputPilihan(nomor, teks) {
        const pilihan = parseInt(teks.trim());

        // 🔹 Tambahan: kalau sesi belum ada → coba ambil dari database
        if (!sesi) {
            nomor = normalisasiNomor(nomor);
            const pesanan = await ambilPesananTerakhirByNomor(nomor);

            if (pesanan) {
                sesi = {
                    ref_no: pesanan.ref_no,
                    tahap: "pilih_metode",
                };
                sesiPengguna[nomor] = sesi;
            }
        }

        // 🔹 Kalau tetap tidak ada sesi atau input bukan angka → kirim pesan default
        if (!sesi || isNaN(pilihan)) {
            await kirimPesanKeWhatsApp(nomor, "Silakan lakukan pemesanan terlebih dahulu.");
            return;
        }

        switch (sesi.tahap) {
            case "pilih_metode": {
                const listMetode = await ambilMetodePembayaran(db);

                if (pilihan >= 1 && pilihan <= listMetode.length) {
                    const metode = listMetode[pilihan];
                    const metodeId = metode.id;
                    const namaMetode = metode.nama_metode;
                    const noRek = metode.no_rekening || "-";
                    const atasNama = metode.atas_nama || "-";

                    await updateMetodePembayaran(sesi.ref_no, metodeId);

                    if (namaMetode.toLowerCase().includes("cod")) {
                        await updateStatusPesanan(sesi.ref_no, "Perlu Dikirim");
                        await kirimPesanKeWhatsApp(
                            nomor,
                            `Metode pembayaran *${namaMetode}* dipilih untuk pesanan *${sesi.ref_no}*.\n\n` +
                            `Barang akan segera dikirim.\n` +
                            `Silakan siapkan pembayaran saat barang tiba (Cash on Delivery).`
                        );
                    } else {
                        await updateStatusPesanan(sesi.ref_no, "Menunggu Pembayaran");
                        await kirimPesanKeWhatsApp(
                            nomor,
                            `Metode pembayaran *${namaMetode}* dipilih untuk pesanan *${sesi.ref_no}*.\n\n` +
                            `Silakan lakukan pembayaran ke rekening berikut:\n` +
                            `Bank: *${namaMetode}*\nNomor: *${noRek}*\nAtas Nama: *${atasNama}*\n\n` +
                            `Kirim bukti transfer ke sini agar pesanan bisa segera dikirim.`
                        );
                    }

                    delete sesiPengguna[nomor];
                } else {
                    await kirimPesanKeWhatsApp(
                        nomor,
                        "❌ Pilihan tidak valid. Silakan ketik angka sesuai daftar metode pembayaran."
                    );
                }

                break;
            }

            default: {
                await kirimPesanKeWhatsApp(
                    nomor,
                    "Tahap sesi tidak dikenali. Silakan mulai ulang pemesanan."
                );
                delete sesiPengguna[nomor];
                break;
            }
        }
    }

    function normalisasiNomor(nomor) {
        // Hapus domain WhatsApp
        let n = nomor.replace(/@s\.whatsapp\.net$/, '');

        // Ubah 62xxxx jadi 0xxxx
        if (n.startsWith('62')) {
            n = '0' + n.slice(2);
        }

        return n;
    }

    async function ambilPesananTerakhirByNomor(nomor) {
        nomor = nomor.replace(/@s\.whatsapp\.net$/, ''); // 🔹 bersihkan suffix WA

        const hasil = await db.query(
            `SELECT ref_no 
         FROM pesanan_online 
         WHERE no_hp = ? 
         ORDER BY tanggal_order DESC 
         LIMIT 1`,
            [nomor]
        );

        if (hasil.length > 0) {
            return hasil[0];
        }
        return null;
    }

    async function getProdukIdByNama(namaProduk) {
        const [rows] = await db.execute("SELECT id FROM produk WHERE nama = ?", [namaProduk]);
        return rows.length > 0 ? rows[0].id : null;
    }

    async function generateRefNo() {
        const today = new Date();
        const yyyyMMdd = today.toISOString().slice(0, 10).replace(/-/g, '');

        const [rows] = await db.execute(
            'SELECT COUNT(*) as count FROM pesanan_online WHERE DATE(tanggal_order) = CURDATE()'
        );

        const noUrut = rows[0].count + 1;
        const refNo = `ORD-${yyyyMMdd}-${noUrut.toString().padStart(4, '0')}`;

        return refNo;
    }

    async function ambilMetodePembayaran(db) {
        const [rows] = await db.execute('SELECT id, nama_metode, no_rekening, atas_nama FROM metode_pembayaran');
        return rows; // ✅ sekarang listMetode = array of object
    }

    async function updateMetodePembayaran(ref_no, metode) {
        try {
            const [result] = await db.execute(
                'UPDATE pesanan_online SET metode_pembayaran_id = ? WHERE ref_no = ?',
                [metode, ref_no]
            );
            console.log('Hasil update:', result);
            return result.affectedRows > 0;
        } catch (err) {
            console.error('Gagal update metode pembayaran:', err);
            return false;
        }
    }

    async function updateStatusPesanan(refNo, statusBaru) {
        try {
            await db.execute(
                "UPDATE pesanan_online SET status_order = ? WHERE ref_no = ?",
                [statusBaru, refNo]
            );
            console.log(`✅ Status pesanan ${refNo} diubah menjadi ${statusBaru}`);
        } catch (error) {
            console.error("❌ Gagal update status pesanan:", error.message);
            throw error;
        }
    }

    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));

    app.get('/qr', (req, res) => {
        if (fs.existsSync('./qr.html')) {
            res.sendFile(__dirname + '/qr.html');
        } else {
            res.send('QR belum tersedia');
        }
    });

    app.get('/status', (req, res) => {
        res.json({ login: isConnected });
    });

    app.post('/kirim-wa', async (req, res) => {
        const { nomor, pesan } = req.body;

        try {
            // Contoh pakai Baileys
            await kirimPesanKeWhatsApp(nomor, pesan);
            res.json({ sukses: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ sukses: false, error: err.message });
        }
    });

    app.post('/kirim-wa-total-harga', async (req, res) => {
        const { nomor, pesan, refNo } = req.body; // ✅ ambil refNo dari body
        try {
            // Kirim pesan WhatsApp pakai Baileys
            await kirimPesanKeWhatsApp(nomor, pesan);

            // Simpan sesi sedang pilih metode
            sesiPengguna[nomor] = {
                ref_no: refNo,
                tahap: "pilih_metode",
                waktu: Date.now()
            };
            sesi = sesiPengguna[nomor];

            res.json({ sukses: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ sukses: false, error: err.message });
        }
    });

    app.post('/kirim-wa-status-dikirim', async (req, res) => {
        const { nomor, refNo, pesan } = req.body; // dikirim dari WinForms

        try {
            // Kirim pesan ke WhatsApp via Baileys
            await kirimPesanKeWhatsApp(nomor, pesan);
            console.log(`✅ Pesan 'Dikirim' terkirim ke ${nomor} untuk ref_no ${refNo}`);

            // (Opsional) simpan sesi untuk tracking
            sesiPengguna[nomor] = {
                ref_no: refNo,
                tahap: "status_dikirim",
                waktu: Date.now()
            };

            res.json({ sukses: true, message: 'Pesan status dikirim berhasil dikirim via WhatsApp' });
        } catch (err) {
            console.error('❌ Gagal kirim notifikasi dikirim:', err);
            res.status(500).json({ sukses: false, error: err.message });
        }
    });

    app.post('/kirim-wa-selesai', async (req, res) => {
        const { nomor, refNo, pesan } = req.body; // dikirim dari WinForms

        try {
            // Kirim pesan ke WhatsApp via Baileys
            await kirimPesanKeWhatsApp(nomor, pesan);
            console.log(`✅ Pesan 'Selesai' terkirim ke ${nomor} untuk ref_no ${refNo}`);

            // (Opsional) simpan sesi untuk tracking
            sesiPengguna[nomor] = {
                ref_no: refNo,
                tahap: "status_selesai",
                waktu: Date.now()
            };

            // Kirim respon sukses ke client (WinForms)
            res.json({ sukses: true, message: 'Pesan status selesai berhasil dikirim via WhatsApp' });
        } catch (err) {
            console.error('❌ Gagal kirim notifikasi selesai:', err);
            res.status(500).json({ sukses: false, error: err.message });
        }
    });

    app.post('/kirim-wa-status-dibatalkan', async (req, res) => {
        const { nomor, refNo, pesan } = req.body; // dikirim dari WinForms

        try {
            // Kirim pesan ke WhatsApp via Baileys
            await kirimPesanKeWhatsApp(nomor, pesan);
            console.log(`❌ Pesan 'Dibatalkan' terkirim ke ${nomor} untuk ref_no ${refNo}`);

            // (Opsional) simpan sesi ke dalam objek tracking
            sesiPengguna[nomor] = {
                ref_no: refNo,
                tahap: "status_dibatalkan",
                waktu: Date.now()
            };

            // Kirim respon sukses ke client (WinForms)
            res.json({ sukses: true, message: 'Pesan status dibatalkan berhasil dikirim via WhatsApp' });
        } catch (err) {
            console.error('❌ Gagal kirim notifikasi dibatalkan:', err);
            res.status(500).json({ sukses: false, error: err.message });
        }
    });

    app.listen(3000, () => console.log('✅ Server aktif di http://localhost:3000'));
};

start();