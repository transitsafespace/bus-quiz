const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QUESTIONS = require('./questions');

const PORT = process.env.PORT || 3000;
const HOST_KEY = process.env.HOST_KEY || ''; // ตั้งไว้เพื่อกันคนอื่นเปิดหน้าผู้จัด
const QUESTION_SECONDS = 20;
const BONUS_POINTS = 2;
const GRACE_MS = 600; // เผื่อเน็ตช้าตอนกดส่งวินาทีสุดท้าย

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

// ---------- สถานะเกม ----------
const game = {
  phase: 'lobby', // lobby | question | reveal | leaderboard | final
  qIndex: -1,
  startedAt: 0,
  endsAt: 0,
  timer: null,
  autoEndTimer: null,
  reveal: null,
  gains: new Map(),
};
const players = new Map(); // id -> { id, name, score, connected, socketId, joinedAt, answers: {qIndex: {...}} }

const newId = () => crypto.randomBytes(9).toString('base64url');
const cleanName = (raw) =>
  String(raw || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);

function sortedPlayers() {
  return [...players.values()].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
}
function rankMap() {
  const m = new Map();
  let lastScore = null;
  let lastRank = 0;
  sortedPlayers().forEach((p, i) => {
    if (p.score !== lastScore) { lastRank = i + 1; lastScore = p.score; }
    m.set(p.id, lastRank);
  });
  return m;
}
const connectedPlayers = () => [...players.values()].filter((p) => p.connected);
const answeredCount = () =>
  game.qIndex < 0 ? 0 : [...players.values()].filter((p) => p.answers[game.qIndex]).length;

function publicState() {
  const s = {
    phase: game.phase,
    qIndex: game.qIndex,
    total: QUESTIONS.length,
    seconds: QUESTION_SECONDS,
    serverNow: Date.now(),
    playerCount: connectedPlayers().length,
    answeredCount: answeredCount(),
    lobby: connectedPlayers().sort((a, b) => a.joinedAt - b.joinedAt).map((p) => p.name),
  };
  if (game.phase === 'question' || game.phase === 'reveal') {
    const q = QUESTIONS[game.qIndex];
    s.question = { text: q.text, options: q.options, multi: q.multi, type: q.type };
    s.endsAt = game.endsAt;
  }
  if (game.phase === 'reveal') s.reveal = game.reveal;
  if (game.phase === 'leaderboard' || game.phase === 'final') {
    const ranks = rankMap();
    s.leaderboard = sortedPlayers().map((p) => ({
      name: p.name,
      score: p.score,
      gain: game.gains.get(p.id) || 0,
      rank: ranks.get(p.id),
    }));
  }
  return s;
}

function meState(p) {
  const ranks = rankMap();
  const me = {
    id: p.id,
    name: p.name,
    score: p.score,
    rank: ranks.get(p.id),
    playerTotal: players.size,
  };
  if (game.phase === 'question' || game.phase === 'reveal') {
    const a = p.answers[game.qIndex];
    me.answered = !!a;
    me.choices = a ? a.choices : [];
    if (game.phase === 'reveal') {
      me.result = a ? { points: a.points, bonus: a.bonus } : null;
    }
  }
  if (game.phase === 'leaderboard' || game.phase === 'final') me.gain = game.gains.get(p.id) || 0;
  return me;
}

function broadcast() {
  io.emit('state', publicState());
  for (const p of players.values()) {
    if (p.socketId) io.to(p.socketId).emit('me', meState(p));
  }
}

// ---------- ลำดับเกม ----------
function startQuestion(i) {
  clearTimeout(game.timer);
  clearTimeout(game.autoEndTimer);
  game.autoEndTimer = null;
  game.phase = 'question';
  game.qIndex = i;
  game.reveal = null;
  game.startedAt = Date.now();
  game.endsAt = game.startedAt + QUESTION_SECONDS * 1000;
  game.timer = setTimeout(endQuestion, QUESTION_SECONDS * 1000 + 250);
  broadcast();
}

function endQuestion() {
  if (game.phase !== 'question') return;
  clearTimeout(game.timer);
  clearTimeout(game.autoEndTimer);
  game.autoEndTimer = null;

  const q = QUESTIONS[game.qIndex];
  const counts = q.options.map(() => 0);
  let answered = 0;
  let fastest = null;

  for (const p of players.values()) {
    const a = p.answers[game.qIndex];
    if (!a) continue;
    answered++;
    a.choices.forEach((c) => counts[c]++);
    // ตัวเลือกที่ถูก ตัวละ 1 คะแนน, ตัวเลือกที่ผิด 0 คะแนน (ไม่หัก)
    a.points = a.choices.filter((c) => q.correct.includes(c)).length;
    a.bonus = 0;
    // มีสิทธิ์โบนัส: ต้องเลือกถูกอย่างน้อย 1 ข้อ และไม่เลือกข้อผิดเลย
    const hasWrong = a.choices.some((c) => !q.correct.includes(c));
    if (a.points > 0 && !hasWrong && (!fastest || a.timeMs < fastest.a.timeMs)) fastest = { p, a };
  }
  if (fastest) fastest.a.bonus = BONUS_POINTS;

  game.gains = new Map();
  for (const p of players.values()) {
    const a = p.answers[game.qIndex];
    const gain = a ? a.points + a.bonus : 0;
    p.score += gain;
    game.gains.set(p.id, gain);
  }

  const max = Math.max(0, ...counts);
  game.reveal = {
    counts,
    answered,
    correct: q.correct,
    explanations: q.explanations || {},
    top: max > 0 ? counts.map((c, i) => (c === max ? i : -1)).filter((i) => i >= 0) : [],
    bonus: fastest ? { name: fastest.p.name, seconds: (fastest.a.timeMs / 1000).toFixed(2) } : null,
  };
  game.phase = 'reveal';
  broadcast();
}

function next() {
  if (game.phase === 'lobby') startQuestion(0);
  else if (game.phase === 'question') endQuestion();
  else if (game.phase === 'reveal') {
    game.phase = game.qIndex >= QUESTIONS.length - 1 ? 'final' : 'leaderboard';
    broadcast();
  } else if (game.phase === 'leaderboard') startQuestion(game.qIndex + 1);
}

function reset() {
  clearTimeout(game.timer);
  clearTimeout(game.autoEndTimer);
  game.autoEndTimer = null;
  Object.assign(game, { phase: 'lobby', qIndex: -1, startedAt: 0, endsAt: 0, reveal: null, gains: new Map() });
  for (const [id, p] of players) {
    if (!p.connected) players.delete(id);
    else { p.score = 0; p.answers = {}; }
  }
  broadcast();
}

// ทุกคนที่ออนไลน์ตอบครบแล้ว ก็ไม่ต้องรอจนหมดเวลา
function maybeAutoEnd() {
  if (game.phase !== 'question' || game.autoEndTimer) return;
  const online = connectedPlayers();
  if (online.length > 0 && online.every((p) => p.answers[game.qIndex])) {
    game.autoEndTimer = setTimeout(endQuestion, 800);
  }
}

// ---------- Socket ----------
io.on('connection', (socket) => {
  socket.emit('state', publicState());

  socket.on('host:join', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    if (HOST_KEY && (!data || data.key !== HOST_KEY)) return reply({ ok: false, error: 'รหัสผู้จัดไม่ถูกต้อง' });
    socket.data.isHost = true;
    reply({ ok: true });
    socket.emit('state', publicState());
  });
  socket.on('host:next', () => { if (socket.data.isHost) next(); });
  socket.on('host:reset', () => { if (socket.data.isHost) reset(); });

  socket.on('player:join', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const existing = data && typeof data.playerId === 'string' ? players.get(data.playerId) : null;

    if (existing) {
      // กลับเข้ามาใหม่ (รีเฟรช/เน็ตหลุด) คะแนนเดิมยังอยู่
      if (existing.socketId && existing.socketId !== socket.id) {
        io.to(existing.socketId).emit('kicked', 'ชื่อนี้เปิดเล่นอยู่ในหน้าจออื่น');
      }
      existing.socketId = socket.id;
      existing.connected = true;
      socket.data.playerId = existing.id;
      reply({ ok: true, playerId: existing.id });
      broadcast();
      return;
    }

    const name = cleanName(data && data.name);
    if (!name) return reply({ ok: false, error: 'กรุณาใส่ชื่อ' });
    const taken = [...players.values()].some((p) => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return reply({ ok: false, error: 'ชื่อนี้มีคนใช้แล้ว ลองเติมอะไรต่อท้ายดูนะ' });

    const p = {
      id: newId(), name, score: 0, connected: true, socketId: socket.id, joinedAt: Date.now(), answers: {},
    };
    players.set(p.id, p);
    socket.data.playerId = p.id;
    reply({ ok: true, playerId: p.id });
    broadcast();
  });

  socket.on('player:answer', (data, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const p = players.get(socket.data.playerId);
    if (!p) return reply({ ok: false, error: 'กรุณาใส่ชื่อก่อนเล่น' });
    if (game.phase !== 'question' || !data || data.qIndex !== game.qIndex || Date.now() > game.endsAt + GRACE_MS) {
      return reply({ ok: false, error: 'หมดเวลาตอบข้อนี้แล้ว' });
    }
    if (p.answers[game.qIndex]) return reply({ ok: false, error: 'คุณตอบข้อนี้ไปแล้ว' });

    const q = QUESTIONS[game.qIndex];
    const choices = Array.isArray(data.choices)
      ? [...new Set(data.choices)].filter((c) => Number.isInteger(c) && c >= 0 && c < q.options.length).sort((a, b) => a - b)
      : [];
    if (!choices.length || (!q.multi && choices.length !== 1)) {
      return reply({ ok: false, error: 'เลือกคำตอบก่อนกดส่ง' });
    }

    p.answers[game.qIndex] = { choices, timeMs: Date.now() - game.startedAt };
    reply({ ok: true });
    broadcast();
    maybeAutoEnd();
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.data.playerId);
    if (p && p.socketId === socket.id) {
      p.connected = false;
      p.socketId = null;
      broadcast();
      maybeAutoEnd();
    }
  });
});

server.listen(PORT, () => {
  console.log(`ควิซพร้อมแล้ว`);
  console.log(`  ผู้เล่น : http://localhost:${PORT}/`);
  console.log(`  ผู้จัด  : http://localhost:${PORT}/host${HOST_KEY ? '?key=' + HOST_KEY : ''}`);
});
