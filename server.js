const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const users = new Map();
const rooms = new Map();

function publicRooms() {
  return Array.from(rooms.values()).map(r => ({
    id: r.id,
    name: r.name,
    mode: r.mode,
    players: r.players.length,
    max: r.mode === 'ttt' ? 2 : 8,
    started: r.started,
  }));
}

function checkWinner(board) {
  const lines = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6],
  ];
  for (const [a, b, c] of lines) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return { winner: board[a], line: [a, b, c] };
    }
  }
  if (board.every(Boolean)) return { winner: 'draw' };
  return null;
}

function makeRoom(name, mode, hostId) {
  const id = Math.random().toString(36).slice(2, 8);
  const room = {
    id,
    name,
    mode,
    hostId,
    players: [],
    started: false,
    chat: [],
  };
  if (mode === 'ttt') {
    room.board = Array(9).fill(null);
    room.turn = null;
    room.winner = null;
  } else if (mode === 'coop') {
    room.target = 30;
    room.count = 0;
    room.lastClickBy = null;
    room.startedAt = null;
    room.timeLimitMs = 30000;
    room.finished = false;
    room.success = false;
  }
  rooms.set(id, room);
  return room;
}

function leaveRoom(socket) {
  const u = users.get(socket.id);
  if (!u || !u.roomId) return;
  const room = rooms.get(u.roomId);
  socket.leave(u.roomId);
  u.roomId = null;
  if (!room) return;
  room.players = room.players.filter(p => p.id !== socket.id);
  io.to(room.id).emit('system', `${u.name} hat den Raum verlassen.`);
  if (room.players.length === 0) {
    rooms.delete(room.id);
  } else {
    if (room.mode === 'ttt') {
      room.started = false;
      room.board = Array(9).fill(null);
      room.turn = null;
      room.winner = null;
      io.to(room.id).emit('ttt:state', tttState(room));
    } else if (room.mode === 'coop') {
      io.to(room.id).emit('coop:state', coopState(room));
    }
    io.to(room.id).emit('room:players', room.players.map(p => ({ id: p.id, name: p.name, symbol: p.symbol })));
  }
  io.emit('rooms', publicRooms());
}

function tttState(room) {
  return {
    board: room.board,
    turn: room.turn,
    winner: room.winner,
    started: room.started,
    players: room.players.map(p => ({ id: p.id, name: p.name, symbol: p.symbol })),
  };
}

function coopState(room) {
  return {
    target: room.target,
    count: room.count,
    lastClickBy: room.lastClickBy,
    started: room.started,
    finished: room.finished,
    success: room.success,
    timeLimitMs: room.timeLimitMs,
    startedAt: room.startedAt,
    players: room.players.map(p => ({ id: p.id, name: p.name })),
  };
}

io.on('connection', (socket) => {
  socket.on('login', (name, cb) => {
    const clean = String(name || '').trim().slice(0, 20);
    if (!clean) return cb && cb({ ok: false, error: 'Name fehlt' });
    users.set(socket.id, { id: socket.id, name: clean, roomId: null });
    cb && cb({ ok: true });
    socket.emit('rooms', publicRooms());
  });

  socket.on('lobby:chat', (text) => {
    const u = users.get(socket.id);
    if (!u) return;
    const msg = String(text || '').trim().slice(0, 300);
    if (!msg) return;
    io.emit('lobby:chat', { from: u.name, text: msg, ts: Date.now() });
  });

  socket.on('room:create', ({ name, mode }, cb) => {
    const u = users.get(socket.id);
    if (!u) return cb && cb({ ok: false, error: 'Nicht eingeloggt' });
    if (!['ttt', 'coop'].includes(mode)) return cb && cb({ ok: false, error: 'Ungültiger Modus' });
    const cleanName = String(name || '').trim().slice(0, 30) || 'Raum';
    const room = makeRoom(cleanName, mode, socket.id);
    cb && cb({ ok: true, roomId: room.id });
    io.emit('rooms', publicRooms());
  });

  socket.on('room:join', (roomId, cb) => {
    const u = users.get(socket.id);
    if (!u) return cb && cb({ ok: false, error: 'Nicht eingeloggt' });
    const room = rooms.get(roomId);
    if (!room) return cb && cb({ ok: false, error: 'Raum nicht gefunden' });
    const max = room.mode === 'ttt' ? 2 : 8;
    if (room.players.length >= max) return cb && cb({ ok: false, error: 'Raum voll' });
    if (u.roomId) leaveRoom(socket);

    const player = { id: socket.id, name: u.name };
    if (room.mode === 'ttt') {
      const used = room.players.map(p => p.symbol);
      player.symbol = used.includes('X') ? 'O' : 'X';
    }
    room.players.push(player);
    u.roomId = room.id;
    socket.join(room.id);

    cb && cb({ ok: true, room: { id: room.id, name: room.name, mode: room.mode } });
    io.to(room.id).emit('system', `${u.name} ist beigetreten.`);
    io.to(room.id).emit('room:players', room.players.map(p => ({ id: p.id, name: p.name, symbol: p.symbol })));
    socket.emit('room:chathistory', room.chat);

    if (room.mode === 'ttt') {
      socket.emit('ttt:state', tttState(room));
    } else if (room.mode === 'coop') {
      socket.emit('coop:state', coopState(room));
    }
    io.emit('rooms', publicRooms());
  });

  socket.on('room:leave', () => {
    leaveRoom(socket);
  });

  socket.on('room:chat', (text) => {
    const u = users.get(socket.id);
    if (!u || !u.roomId) return;
    const room = rooms.get(u.roomId);
    if (!room) return;
    const msg = String(text || '').trim().slice(0, 300);
    if (!msg) return;
    const entry = { from: u.name, text: msg, ts: Date.now() };
    room.chat.push(entry);
    if (room.chat.length > 100) room.chat.shift();
    io.to(room.id).emit('room:chat', entry);
  });

  socket.on('ttt:start', () => {
    const u = users.get(socket.id);
    if (!u || !u.roomId) return;
    const room = rooms.get(u.roomId);
    if (!room || room.mode !== 'ttt') return;
    if (room.players.length !== 2) return;
    room.started = true;
    room.board = Array(9).fill(null);
    room.winner = null;
    room.turn = 'X';
    io.to(room.id).emit('ttt:state', tttState(room));
    io.to(room.id).emit('system', 'Spiel gestartet! X beginnt.');
    io.emit('rooms', publicRooms());
  });

  socket.on('ttt:move', (idx) => {
    const u = users.get(socket.id);
    if (!u || !u.roomId) return;
    const room = rooms.get(u.roomId);
    if (!room || room.mode !== 'ttt' || !room.started || room.winner) return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.symbol !== room.turn) return;
    if (typeof idx !== 'number' || idx < 0 || idx > 8) return;
    if (room.board[idx]) return;
    room.board[idx] = player.symbol;
    const result = checkWinner(room.board);
    if (result) {
      room.winner = result.winner;
      room.started = false;
      io.to(room.id).emit('ttt:state', { ...tttState(room), winLine: result.line || null });
      const msg = result.winner === 'draw' ? 'Unentschieden!' : `${result.winner} gewinnt!`;
      io.to(room.id).emit('system', msg);
      io.emit('rooms', publicRooms());
    } else {
      room.turn = room.turn === 'X' ? 'O' : 'X';
      io.to(room.id).emit('ttt:state', tttState(room));
    }
  });

  socket.on('coop:start', () => {
    const u = users.get(socket.id);
    if (!u || !u.roomId) return;
    const room = rooms.get(u.roomId);
    if (!room || room.mode !== 'coop') return;
    if (room.players.length < 2) return;
    room.started = true;
    room.finished = false;
    room.success = false;
    room.count = 0;
    room.lastClickBy = null;
    room.startedAt = Date.now();
    io.to(room.id).emit('coop:state', coopState(room));
    io.to(room.id).emit('system', `Koop gestartet! Schafft gemeinsam ${room.target} Klicks in ${room.timeLimitMs / 1000}s — aber niemand zweimal hintereinander!`);
    io.emit('rooms', publicRooms());

    setTimeout(() => {
      if (!room.started) return;
      if (room.finished) return;
      room.finished = true;
      room.started = false;
      room.success = room.count >= room.target;
      io.to(room.id).emit('coop:state', coopState(room));
      io.to(room.id).emit('system', room.success
        ? `Geschafft! ${room.count}/${room.target} 🎉`
        : `Zeit abgelaufen — nur ${room.count}/${room.target}.`);
      io.emit('rooms', publicRooms());
    }, room.timeLimitMs);
  });

  socket.on('coop:click', () => {
    const u = users.get(socket.id);
    if (!u || !u.roomId) return;
    const room = rooms.get(u.roomId);
    if (!room || room.mode !== 'coop' || !room.started || room.finished) return;
    if (room.lastClickBy === socket.id && room.players.length > 1) {
      socket.emit('system', 'Erst muss jemand anderes klicken!');
      return;
    }
    room.count += 1;
    room.lastClickBy = socket.id;
    if (room.count >= room.target) {
      room.finished = true;
      room.started = false;
      room.success = true;
      io.to(room.id).emit('coop:state', coopState(room));
      io.to(room.id).emit('system', `Geschafft! ${room.count}/${room.target} 🎉`);
      io.emit('rooms', publicRooms());
    } else {
      io.to(room.id).emit('coop:state', coopState(room));
    }
  });

  socket.on('disconnect', () => {
    const u = users.get(socket.id);
    if (u && u.roomId) leaveRoom(socket);
    users.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server läuft auf http://localhost:${PORT}`);
});
