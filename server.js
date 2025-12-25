const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const TURN_SECONDS = 60;

const CARDS = [
  { word: "PIZZA", taboo: ["FORNO","MOZZARELLA","NAPOLI","MARINARA","TRANCIO"] },
  { word: "CALCIO", taboo: ["PALLONE","GOL","ARBITRO","SERIE A","PORTIERE"] },
  { word: "CHITARRA", taboo: ["CORDE","PLETTRO","ACCORDI","SUONARE","AMPLIFICATORE"] },
  { word: "AEREO", taboo: ["VOLARE","PILOTA","AEROPORTO","ALI","DECOLLO"] },
  { word: "GELATO", taboo: ["CONO","COPPA","ESTATE","GUSTO","PANNA"] },
  { word: "PASSWORD", taboo: ["ACCOUNT","LOGIN","CODICE","EMAIL","SICUREZZA"] },
  { word: "ROMA", taboo: ["COLOSSEO","CAPITALE","TEVERE","VATICANO","TRASTEVERE"] },
  { word: "CINEMA", taboo: ["FILM","SALA","POP CORN","BIGLIETTO","SCHERMO"] },
  { word: "MARE", taboo: ["SPIAGGIA","ONDE","SABBIA","ESTATE","OMBRELLONE"] },
  { word: "PALLAVOLO", taboo: ["RETE","SCHIACCIATA","SERVIZIO","SET","SQUADRA"] },
  { word: "CUCINA", taboo: ["PENTOLA","RICETTA","FORNELLO","CUOCO","INGREDIENTI"] },
  { word: "BICI", taboo: ["PEDALI","RUOTE","CASCO","CATENA","SELLA"] },
  { word: "SMARTPHONE", taboo: ["APP","SCHERMO","CHIAMATA","ANDROID","IPHONE"] },
  { word: "BIBLIOTECA", taboo: ["LIBRI","SILENZIO","STUDIO","PRESTITO","SCAFFALI"] },
  { word: "TENNIS", taboo: ["RACCHETTA","PALLINA","SERVIZIO","CAMPO","SET"] },
  { word: "PESCE", taboo: ["ACQUA","MARE","SQUAME","PINNE","RETE"] },
  { word: "AUTO", taboo: ["MOTORE","VOLANTE","PATENTE","BENZINA","STRADA"] },
  { word: "SCACCHI", taboo: ["RE","REGINA","SCACCO","TORRE","PEDONE"] },
  { word: "MUSICA", taboo: ["CANZONE","SUONO","RITMO","NOTE","ASCOLTARE"] },
  { word: "COMPLEANNO", taboo: ["TORTA","CANDELE","REGALO","FESTA","AUGURI"] },
];

function pickCard() { return CARDS[Math.floor(Math.random() * CARDS.length)]; }
function roomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i=0;i<5;i++) s += chars[Math.floor(Math.random()*chars.length)];
  return s;
}

const rooms = new Map();

function getPublicState(code) {
  const r = rooms.get(code);
  if (!r) return null;
  return {
    code,
    inGame: r.inGame,
    endAt: r.endAt,
    cluegiverId: r.inGame ? r.order[r.clueIdx] : null,
    players: r.order.filter(id => r.players.has(id)).map(id => ({
      id, name: r.players.get(id).name, score: r.players.get(id).score
    })),
    log: r.log.slice(0, 20),
  };
}
function emitState(code) {
  const s = getPublicState(code);
  if (s) io.to(code).emit("room_state", s);
}
function safeClearTimer(r) { if (r.timer) { clearTimeout(r.timer); r.timer = null; } }

function endTurn(code, reason, extra = {}) {
  const r = rooms.get(code);
  if (!r || !r.inGame) return;

  safeClearTimer(r);

  r.log.unshift({
    ts: Date.now(),
    type: "system",
    text: reason === "timeout"
      ? "⏱️ Tempo scaduto! Cambio turno."
      : reason === "guessed"
        ? `✅ Indovinata! (${extra.word}) — punto a ${extra.clueName}`
        : "⏭️ Skippata! Cambio turno.",
  });

  r.clueIdx = (r.clueIdx + 1) % r.order.length;
  r.inGame = false;
  r.endAt = null;
  r.currentCard = null;

  emitState(code);
  io.to(code).emit("card_hidden", { msg: "Turno finito. Avvio prossimo turno…" });

  setTimeout(() => {
    const rr = rooms.get(code);
    if (!rr) return;
    if (rr.order.length < 2) return;
    startTurn(code);
  }, 700);
}

function startTurn(code) {
  const r = rooms.get(code);
  if (!r) return;
  if (r.order.length < 2) {
    r.log.unshift({ ts: Date.now(), type: "system", text: "Servono almeno 2 giocatori." });
    emitState(code);
    return;
  }

  safeClearTimer(r);

  r.inGame = true;
  r.currentCard = pickCard();
  r.endAt = Date.now() + TURN_SECONDS * 1000;

  const clueId = r.order[r.clueIdx];
  io.to(clueId).emit("card", r.currentCard);
  io.to(code).except(clueId).emit("card_hidden", { msg: "Indovina la parola! Scrivi i tentativi." });

  r.log.unshift({
    ts: Date.now(),
    type: "system",
    text: `🎤 Tocca a ${r.players.get(clueId)?.name || "Qualcuno"} descrivere!`,
  });

  emitState(code);
  r.timer = setTimeout(() => endTurn(code, "timeout"), TURN_SECONDS * 1000);
}

io.on("connection", (socket) => {
  socket.on("create_room", ({ name }) => {
    let code; do code = roomCode(); while (rooms.has(code));

    rooms.set(code, {
      hostId: socket.id,
      players: new Map(),
      order: [],
      clueIdx: 0,
      inGame: false,
      endAt: null,
      currentCard: null,
      log: [],
      timer: null,
    });

    const r = rooms.get(code);
    r.players.set(socket.id, { name: name || "Host", score: 0 });
    r.order.push(socket.id);

    socket.join(code);
    socket.data.code = code;

    socket.emit("room_created", { code });
    emitState(code);
  });

  socket.on("join_room", ({ code, name }) => {
    code = (code || "").toUpperCase().trim();
    const r = rooms.get(code);
    if (!r) return socket.emit("error_msg", { msg: "Stanza non trovata." });

    r.players.set(socket.id, { name: name || "Giocatore", score: 0 });
    r.order.push(socket.id);

    socket.join(code);
    socket.data.code = code;

    socket.emit("room_joined", { code });
    r.log.unshift({ ts: Date.now(), type: "system", text: `👋 ${name || "Giocatore"} è entrato.` });
    emitState(code);
  });

  socket.on("start_game", ({ code }) => {
    const r = rooms.get(code);
    if (!r) return;
    if (r.hostId !== socket.id) return socket.emit("error_msg", { msg: "Solo l’host può avviare." });
    if (r.order.length < 2) return socket.emit("error_msg", { msg: "Serve almeno 2 giocatori." });

    r.order = r.order.filter(id => r.players.has(id));
    r.order.forEach(id => (r.players.get(id).score = 0));
    r.clueIdx = 0;
    r.log = [{ ts: Date.now(), type: "system", text: "🎮 Partita iniziata!" }];

    emitState(code);
    startTurn(code);
  });

  socket.on("submit_guess", ({ code, text }) => {
    const r = rooms.get(code);
    if (!r || !r.inGame) return;
    const me = r.players.get(socket.id);
    if (!me) return;

    const clueId = r.order[r.clueIdx];
    const guess = (text || "").trim();
    if (!guess) return;

    r.log.unshift({ ts: Date.now(), type: "guess", text: `💬 ${me.name}: ${guess}` });
    emitState(code);

    if (socket.id === clueId) return;

    if (guess.toUpperCase() === r.currentCard.word.toUpperCase()) {
      const cluePlayer = r.players.get(clueId);
      const clueName = cluePlayer?.name || "Cluegiver";
      if (cluePlayer) cluePlayer.score += 1;
      endTurn(code, "guessed", { word: r.currentCard.word, clueName });
    }
  });

  socket.on("skip", ({ code }) => {
    const r = rooms.get(code);
    if (!r || !r.inGame) return;
    const clueId = r.order[r.clueIdx];
    if (socket.id !== clueId) return socket.emit("error_msg", { msg: "Solo il descrittore può skippare." });
    endTurn(code, "skip");
  });

  socket.on("correct", ({ code }) => {
    const r = rooms.get(code);
    if (!r || !r.inGame) return;
    const clueId = r.order[r.clueIdx];
    if (socket.id !== clueId) return socket.emit("error_msg", { msg: "Solo il descrittore può confermare." });

    const cluePlayer = r.players.get(clueId);
    const clueName = cluePlayer?.name || "Cluegiver";
    if (cluePlayer) cluePlayer.score += 1;
    endTurn(code, "guessed", { word: r.currentCard.word, clueName });
  });

  socket.on("disconnect", () => {
    const code = socket.data.code;
    if (!code) return;
    const r = rooms.get(code);
    if (!r) return;

    if (r.hostId === socket.id) {
      io.to(code).emit("toast", { msg: "L’host è uscito: stanza chiusa." });
      safeClearTimer(r);
      rooms.delete(code);
      return;
    }

    r.players.delete(socket.id);
    r.order = r.order.filter(id => id !== socket.id);
    if (r.clueIdx >= r.order.length) r.clueIdx = 0;

    r.log.unshift({ ts: Date.now(), type: "system", text: "🚪 Un giocatore è uscito." });
    emitState(code);

    if (r.order.length < 2 && r.inGame) {
      safeClearTimer(r);
      r.inGame = false;
      r.endAt = null;
      r.currentCard = null;
      io.to(code).emit("card_hidden", { msg: "Servono almeno 2 giocatori per continuare." });
      emitState(code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => console.log("Running on port", PORT));