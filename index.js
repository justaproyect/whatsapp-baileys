import express from "express";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  jidNormalizedUser,
  isJidGroup,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";
import XLSX from "xlsx";

const logger = pino({ level: "silent" });
const app = express();
const PORT = process.env.PORT || 3000;
const SEARCH_TERM = "Lipo Blue";

let botStatus = "desconectado";

app.get("/", (req, res) => {
  res.send(`WhatsApp Bot - Estado: ${botStatus}`);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", bot: botStatus });
});

app.get("/scrape", (req, res) => {
  res.json({ status: "ok", message: "Ejecuta el scraping desde la consola" });
});

app.listen(PORT, () => {
  console.log(`Servidor HTTP corriendo en puerto ${PORT}`);
});

async function scrapeChats(sock) {
  console.log(`\n=== SCRAPING CHATS QUE CONTIENEN "${SEARCH_TERM}" ===\n`);
  botStatus = "scrapeando";

  const chats = await sock.store.chats.all();
  console.log(`Total de chats encontrados: ${chats.length}`);

  const results = [];

  for (const chat of chats) {
    const chatId = chat.id;
    const chatName = chat.name || chatId;
    const isGroup = isJidGroup(chatId);

    let messages = [];
    try {
      const msgs = await sock.store.loadMessages(chatId, 100);
      messages = msgs || [];
    } catch (e) {
      try {
        const history = await sock.chatHistory(chatId, 100);
        messages = history?.messages || [];
      } catch (e2) {
        console.log(`  No se pudieron cargar mensajes de: ${chatName}`);
      }
    }

    for (const msg of messages) {
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.buttonsResponseMessage?.selectedButtonId ||
        msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        "";

      const fullText = text.toLowerCase();
      if (fullText.includes(SEARCH_TERM.toLowerCase())) {
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
          Mensaje: text.substring(0, 200),
          Fecha: timestamp,
        });

        console.log(`  [ENCONTRADO] ${chatName} | ${pushName} | ${timestamp}`);
      }
    }
  }

  if (results.length === 0) {
    console.log(`\nNo se encontraron mensajes con "${SEARCH_TERM}" en ${chats.length} chats.`);
    console.log("Generando Excel vacio con encabezados...");
    results.push({
      Chat: "(sin resultados)",
      "Es Grupo": "",
      "Contacto/Nombre": "",
      "Numero/JID": "",
      Mensaje: "",
      Fecha: "",
    });
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(results);

  ws["!cols"] = [
    { wch: 30 },
    { wch: 10 },
    { wch: 25 },
    { wch: 30 },
    { wch: 50 },
    { wch: 20 },
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Lipo Blue");

  const fileName = `lipo_blue_${new Date().toISOString().slice(0, 10)}.xlsx`;
  XLSX.writeFile(wb, fileName);

  console.log(`\n=== SCRAPING COMPLETADO ===`);
  console.log(`Resultados: ${results.length}`);
  console.log(`Archivo: ${fileName}\n`);

  botStatus = "conectado";
}

async function startBot() {
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
  });

  sock.ev.on("connection.update", async (update) => {
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
      console.log(`Conexion cerrada. Razon: ${statusCode}. Reconectando: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log("Sesion cerrada. Elimina auth_info/ y vuelve a ejecutar.");
      }
    }

    if (connection === "open") {
      botStatus = "conectado";
      console.log("Conectado a WhatsApp correctamente!");
      console.log("Esperando 3 segundos para cargar chats...");
      await new Promise((r) => setTimeout(r, 3000));
      await scrapeChats(sock);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const from = msg.key.remoteJid;
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        "";

      if (!text) continue;

      console.log(`Mensaje de ${from}: ${text}`);

      if (text.toLowerCase() === "hola") {
        await sock.sendMessage(from, {
          text: "Hola! Soy tu bot de WhatsApp conectado con Baileys.",
        });
      }

      if (text.toLowerCase() === "ping") {
        await sock.sendMessage(from, { text: "Pong!" });
      }
    }
  });
}

console.log("Iniciando WhatsApp Bot...");
startBot();
