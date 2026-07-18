import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  isJidGroup,
  Browsers,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import XLSX from "xlsx";

const logger = pino({ level: "silent" });
const app = express();
const PORT = process.env.PORT || 3000;
const SEARCH_TERM = "Lipo Blue";

let botStatus = "desconectado";
let allMessages = [];
let chatNames = {};
let contacts = {};
let syncDone = false;

app.get("/", (req, res) => {
  res.send(`WhatsApp Bot - Estado: ${botStatus} | Mensajes: ${allMessages.length}`);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", bot: botStatus, messages: allMessages.length, chats: Object.keys(chatNames).length });
});

app.get("/scrape", async (req, res) => {
  if (!globalSock) return res.json({ error: "Bot no conectado" });
  res.json({ status: "scrapeando", messages: allMessages.length });
  doScrape();
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP corriendo en puerto ${PORT}`);
});

let globalSock = null;

async function doScrape() {
  console.log(`\n=== SCRAPING: BUSCANDO "${SEARCH_TERM}" ===`);
  console.log(`Mensajes totales: ${allMessages.length}`);
  console.log(`Chats: ${Object.keys(chatNames).length}`);
  console.log(`Contactos: ${Object.keys(contacts).length}`);
  botStatus = "scrapeando";

  const results = [];

  for (const msg of allMessages) {
    const chatId = msg.chatId || msg.key?.remoteJid || "";
    const chatName = chatNames[chatId] || contacts[chatId] || chatId;
    const isGroup = isJidGroup(chatId);

    const text =
      msg.message?.conversation ||
      msg.message?.extendedTextMessage?.text ||
      msg.message?.buttonsResponseMessage?.selectedButtonId ||
      msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
      msg.message?.imageMessage?.caption ||
      msg.message?.videoMessage?.caption ||
      "";

    if (!text) continue;

    if (text.toLowerCase().includes(SEARCH_TERM.toLowerCase())) {
      const pushName = msg.pushName || "";
      const sender = msg.key?.participant || msg.key?.remoteJid || "";
      const timestamp = msg.messageTimestamp
        ? new Date(msg.messageTimestamp * 1000).toLocaleString("es-PE")
        : "";

      results.push({
        Chat: chatName,
        "Es Grupo": isGroup ? "Si" : "No",
        "Contacto/Nombre": pushName,
        "Numero/JID": sender,
        Mensaje: text.substring(0, 300),
        Fecha: timestamp,
      });
    }
  }

  if (results.length === 0) {
    console.log(`Sin coincidencias exactas. Exportando todos los mensajes como referencia...`);
    for (const msg of allMessages) {
      const chatId = msg.chatId || msg.key?.remoteJid || "";
      const chatName = chatNames[chatId] || contacts[chatId] || chatId;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";
      if (!text) continue;
      results.push({
        Chat: chatName,
        "Es Grupo": isJidGroup(chatId) ? "Si" : "No",
        "Contacto/Nombre": msg.pushName || "",
        "Numero/JID": msg.key?.participant || chatId,
        Mensaje: text.substring(0, 300),
        Fecha: msg.messageTimestamp
          ? new Date(msg.messageTimestamp * 1000).toLocaleString("es-PE")
          : "",
      });
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(results);
  ws["!cols"] = [
    { wch: 30 },
    { wch: 10 },
    { wch: 25 },
    { wch: 30 },
    { wch: 60 },
    { wch: 25 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, "Lipo Blue");

  const fileName = `lipo_blue_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fileName);

  console.log(`\n=== SCRAPING COMPLETADO ===`);
  console.log(`Coincidencias "${SEARCH_TERM}": ${results.length}`);
  console.log(`Archivo: ${fileName}\n`);

  botStatus = "conectado";
}

async function fetchAllHistory(sock) {
  console.log("Solicitando historial de todos los chats...");
  const chatIds = Object.keys(chatNames);
  let fetched = 0;

  for (const chatId of chatIds) {
    try {
      const msgs = allMessages.filter(m => (m.chatId || m.key?.remoteJid) === chatId);
      if (msgs.length === 0) continue;

      const oldest = msgs.reduce((a, b) =>
        (a.messageTimestamp || 0) < (b.messageTimestamp || 0) ? a : b
      );

      if (oldest.messageTimestamp && oldest.key) {
        await sock.fetchMessageHistory(
          100,
          {
            remoteJid: chatId,
            id: oldest.key.id,
            fromMe: oldest.key.fromMe || false,
          },
          oldest.messageTimestamp * 1000
        );
        fetched++;
        console.log(`  Historial solicitado: ${chatNames[chatId] || chatId} (${fetched}/${chatIds.length})`);
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      // skip
    }
  }
  console.log(`Historial solicitado de ${fetched} chats.`);
}

async function startBot() {
  allMessages = [];
  chatNames = {};
  contacts = {};

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    printQRInTerminal: false,
    logger,
    markOnlineOnConnect: false,
    syncFullHistory: true,
    browser: Browsers.macOS("Desktop"),
  });

  globalSock = sock;

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      botStatus = "esperando_qr";
      console.log("Escanea este codigo QR con WhatsApp:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      botStatus = "desconectado";
      syncDone = false;
      console.log(`Conexion cerrada (${statusCode}). Reconectando: ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(startBot, 3000);
    }

    if (connection === "open") {
      botStatus = "sincronizando";
      console.log("Conectado a WhatsApp!");
      console.log("Esperando 30 segundos para descargar historial completo...");
      setTimeout(async () => {
        console.log(`Mensajes recolectados: ${allMessages.length}`);
        console.log(`Chats: ${Object.keys(chatNames).length}`);
        syncDone = true;

        console.log("Intentando descargar mas historial de cada chat...");
        await fetchAllHistory(sock);

        await new Promise(r => setTimeout(r, 10000));
        console.log(`Mensajes totales despues de fetch: ${allMessages.length}`);

        await doScrape();
      }, 30000);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messaging-history.set", ({ chats, messages, contacts: newContacts, isLatest }) => {
    console.log(`[HISTORY] ${chats.length} chats, ${messages.length} mensajes, ${Object.keys(newContacts || {}).length} contactos`);
    for (const chat of chats) {
      chatNames[chat.id] = chat.name || "";
    }
    for (const [jid, contact] of Object.entries(newContacts || {})) {
      contacts[jid] = contact.name || contact.notify || "";
    }
    allMessages.push(...messages);
    console.log(`  Total acumulado: ${allMessages.length} mensajes`);
  });

  sock.ev.on("chats.upsert", (chats) => {
    for (const chat of chats) {
      chatNames[chat.id] = chat.name || "";
    }
  });

  sock.ev.on("contacts.upsert", (newContacts) => {
    for (const contact of newContacts) {
      contacts[contact.id] = contact.name || contact.notify || "";
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    allMessages.push(...messages);

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const from = msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";
      if (!text) continue;

      console.log(`Mensaje de ${from}: ${text.substring(0, 60)}`);

      if (text.toLowerCase() === "hola") {
        sock.sendMessage(from, { text: "Hola! Bot conectado con Baileys." });
      }
      if (text.toLowerCase() === "ping") {
        sock.sendMessage(from, { text: "Pong!" });
      }
    }
  });
}

console.log("Iniciando WhatsApp Bot...");
startBot();
