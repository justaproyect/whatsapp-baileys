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
const BATCH_SIZE = 20;

let botStatus = "desconectado";
let allMessages = [];
let chatNames = {};
let contacts = {};
let globalSock = null;
let totalResults = [];
let processedChats = 0;

app.get("/", (req, res) => {
  res.send(
    `Bot: ${botStatus} | Msgs: ${allMessages.length} | ` +
    `Chats: ${Object.keys(chatNames).length} | ` +
    `Procesados: ${processedChats}/${Object.keys(chatNames).length} | ` +
    `Coincidencias: ${totalResults.length}`
  );
});

app.get("/health", (req, res) => {
  res.json({
    bot: botStatus,
    messages: allMessages.length,
    chats: Object.keys(chatNames).length,
    processed: processedChats,
    coincidencias: totalResults.length,
  });
});

app.listen(PORT, () => {
  console.log(`HTTP server en puerto ${PORT}`);
});

function extractText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    ""
  );
}

function buildRow(msg, chatId) {
  const chatName = chatNames[chatId] || contacts[chatId] || chatId;
  return {
    Chat: chatName,
    "Es Grupo": isJidGroup(chatId) ? "Si" : "No",
    Contacto: msg.pushName || "",
    Numero: msg.key?.participant || chatId,
    Mensaje: extractText(msg).substring(0, 300),
    Fecha: msg.messageTimestamp
      ? new Date(msg.messageTimestamp * 1000).toLocaleString("es-PE")
      : "",
  };
}

function exportExcel(results, fileName) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(results);
  ws["!cols"] = [
    { wch: 30 }, { wch: 10 }, { wch: 25 },
    { wch: 30 }, { wch: 60 }, { wch: 25 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, "Lipo Blue");
  XLSX.writeFile(wb, fileName);
  console.log(`Excel guardado: ${fileName} (${results.length} registros)`);
}

async function processBatch(sock, chatIds, batchStart) {
  const batch = chatIds.slice(batchStart, batchStart + BATCH_SIZE);
  if (batch.length === 0) return false;

  const batchEnd = Math.min(batchStart + BATCH_SIZE, chatIds.length);
  console.log(`\n========== BATCH ${batchStart + 1}-${batchEnd} de ${chatIds.length} ==========`);
  botStatus = `batch_${batchStart + 1}-${batchEnd}`;

  for (let i = 0; i < batch.length; i++) {
    const chatId = batch[i];
    const chatName = chatNames[chatId] || chatId;
    processedChats++;

    console.log(`\n[${processedChats}/${chatIds.length}] ${chatName}`);

    const existingMsgs = allMessages.filter(m => (m.chatId || m.key?.remoteJid) === chatId);

    if (existingMsgs.length > 0) {
      const oldest = existingMsgs.reduce((a, b) =>
        (a.messageTimestamp || 0) < (b.messageTimestamp || 0) ? a : b
      );

      if (oldest.messageTimestamp && oldest.key) {
        try {
          console.log(`  Solicitando historial anterior a ${new Date(oldest.messageTimestamp * 1000).toLocaleDateString("es-PE")}...`);
          const prevCount = allMessages.length;

          await sock.fetchMessageHistory(
            100,
            { remoteJid: chatId, id: oldest.key.id, fromMe: oldest.key.fromMe || false },
            oldest.messageTimestamp * 1000
          );

          await new Promise(r => setTimeout(r, 3000));

          const newMsgs = allMessages.length - prevCount;
          console.log(`  +${newMsgs} mensajes nuevos descargados`);
        } catch (e) {
          console.log(`  Error descargando historial`);
        }
      }
    }

    const chatMsgs = allMessages.filter(m => (m.chatId || m.key?.remoteJid) === chatId);
    let hits = 0;
    for (const msg of chatMsgs) {
      const text = extractText(msg);
      if (text.toLowerCase().includes(SEARCH_TERM.toLowerCase())) {
        totalResults.push(buildRow(msg, chatId));
        hits++;
      }
    }
    console.log(`  ${chatMsgs.length} mensajes revisados | ${hits} coincidencias`);
  }

  const fileName = `lipo_blue_${new Date().toISOString().slice(0, 10)}.xlsx`;
  exportExcel([...totalResults], fileName);

  console.log(`\n===== RESUMEN PARCIAL =====`);
  console.log(`Chats procesados: ${processedChats}/${chatIds.length}`);
  console.log(`Total coincidencias "${SEARCH_TERM}": ${totalResults.length}`);
  console.log(`Mensajes totales: ${allMessages.length}\n`);

  return batchEnd < chatIds.length;
}

async function startBot() {
  allMessages = [];
  chatNames = {};
  contacts = {};
  totalResults = [];
  processedChats = 0;

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
    browser: Browsers.ubuntu("Chrome"),
  });

  globalSock = sock;

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      botStatus = "esperando_qr";
      console.log("\nEscanea este QR:\n");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const reconnect = code !== DisconnectReason.loggedOut;
      botStatus = "desconectado";
      console.log(`Conexion cerrada (${code}). Reconectando: ${reconnect}`);
      if (reconnect) setTimeout(startBot, 3000);
    }

    if (connection === "open") {
      botStatus = "sincronizando";
      console.log("Conectado! Esperando historial base (20s)...");

      setTimeout(async () => {
        const chatIds = Object.keys(chatNames);
        console.log(`\nChats base: ${chatIds.length} | Mensajes: ${allMessages.length}`);

        if (chatIds.length === 0) {
          console.log("Sin chats. Esperando mensajes nuevos...");
          botStatus = "conectado";
          return;
        }

        botStatus = "procesando_batches";
        let batchStart = 0;
        let hasMore = true;

        while (hasMore) {
          hasMore = await processBatch(sock, chatIds, batchStart);
          batchStart += BATCH_SIZE;

          if (hasMore) {
            console.log("Pausa de 5 segundos antes del siguiente batch...");
            await new Promise(r => setTimeout(r, 5000));
          }
        }

        const finalFile = `lipo_blue_${new Date().toISOString().slice(0, 10)}.xlsx`;
        exportExcel([...totalResults], finalFile);

        console.log(`\n========================================`);
        console.log(`===== SCRAPING COMPLETADO =====`);
        console.log(`Chats procesados: ${processedChats}`);
        console.log(`Mensajes totales: ${allMessages.length}`);
        console.log(`Coincidencias "${SEARCH_TERM}": ${totalResults.length}`);
        console.log(`Archivo: ${finalFile}`);
        console.log(`========================================\n`);

        botStatus = "conectado";
      }, 20000);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messaging-history.set", ({ chats, messages, contacts: newContacts }) => {
    console.log(`[SYNC] +${chats.length} chats, +${messages.length} msgs`);
    for (const chat of chats) chatNames[chat.id] = chat.name || "";
    for (const [jid, c] of Object.entries(newContacts || {})) contacts[jid] = c.name || c.notify || "";
    allMessages.push(...messages);
  });

  sock.ev.on("chats.upsert", (chats) => {
    for (const chat of chats) chatNames[chat.id] = chat.name || "";
  });

  sock.ev.on("contacts.upsert", (newContacts) => {
    for (const c of newContacts) contacts[c.id] = c.name || c.notify || "";
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    allMessages.push(...messages);
  });
}

console.log("Iniciando WhatsApp Bot...");
startBot();
