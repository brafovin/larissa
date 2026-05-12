const socket = io();

const $ = (id) => document.getElementById(id);
const views = {
  login: $('login-view'),
  lobby: $('lobby-view'),
  room: $('room-view'),
};
function show(name) {
  Object.entries(views).forEach(([k, el]) => el.classList.toggle('hidden', k !== name));
}

let me = null;
let currentRoom = null;

$('login-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('login-name').value.trim();
  if (!name) return;
  socket.emit('login', name, (res) => {
    if (res.ok) {
      me = name;
      $('me').textContent = `Eingeloggt als ${name}`;
      show('lobby');
    } else {
      alert(res.error || 'Login fehlgeschlagen');
    }
  });
});

$('lobby-chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('lobby-chat-input');
  if (input.value.trim()) {
    socket.emit('lobby:chat', input.value);
    input.value = '';
  }
});

socket.on('lobby:chat', ({ from, text }) => {
  const li = document.createElement('li');
  li.innerHTML = `<span class="from"></span><span class="msg"></span>`;
  li.querySelector('.from').textContent = from + ':';
  li.querySelector('.msg').textContent = text;
  const list = $('lobby-chat');
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
});

socket.on('rooms', (rooms) => {
  const ul = $('rooms-list');
  ul.innerHTML = '';
  if (rooms.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Noch keine Räume — erstelle einen!';
    li.style.color = '#94a3b8';
    ul.appendChild(li);
    return;
  }
  for (const r of rooms) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    const modeName = r.mode === 'ttt' ? 'Tic-Tac-Toe' : 'Koop';
    label.textContent = `${r.name} — ${modeName} (${r.players}/${r.max})${r.started ? ' • läuft' : ''}`;
    const btn = document.createElement('button');
    btn.textContent = 'Beitreten';
    btn.disabled = r.players >= r.max;
    btn.onclick = () => socket.emit('room:join', r.id, (res) => {
      if (!res.ok) alert(res.error);
    });
    li.append(label, btn);
    ul.appendChild(li);
  }
});

$('create-room').onclick = () => {
  const name = $('new-room-name').value.trim() || 'Neuer Raum';
  const mode = $('new-room-mode').value;
  socket.emit('room:create', { name, mode }, (res) => {
    if (!res.ok) return alert(res.error);
    socket.emit('room:join', res.roomId, (jr) => {
      if (!jr.ok) alert(jr.error);
    });
    $('new-room-name').value = '';
  });
};

socket.on('room:players', (players) => {
  const ul = $('players-list');
  ul.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    const label = p.symbol ? `${p.name} (${p.symbol})` : p.name;
    li.textContent = label + (p.name === me ? ' — du' : '');
    ul.appendChild(li);
  }
});

socket.on('system', (text) => {
  for (const id of ['lobby-chat', 'room-chat']) {
    const list = $(id);
    if (!list) continue;
    const li = document.createElement('li');
    li.className = 'sys';
    li.textContent = '— ' + text;
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
  }
});

socket.on('room:chat', ({ from, text }) => appendRoomChat(from, text));
socket.on('room:chathistory', (history) => {
  $('room-chat').innerHTML = '';
  for (const m of history) appendRoomChat(m.from, m.text);
});
function appendRoomChat(from, text) {
  const li = document.createElement('li');
  li.innerHTML = `<span class="from"></span><span class="msg"></span>`;
  li.querySelector('.from').textContent = from + ':';
  li.querySelector('.msg').textContent = text;
  const list = $('room-chat');
  list.appendChild(li);
  list.scrollTop = list.scrollHeight;
}

$('room-chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('room-chat-input');
  if (input.value.trim()) {
    socket.emit('room:chat', input.value);
    input.value = '';
  }
});

$('leave-room').onclick = () => {
  socket.emit('room:leave');
  currentRoom = null;
  show('lobby');
};

socket.on('connect', () => { /* connected */ });

const origJoin = socket.emit.bind(socket);
socket.on('disconnect', () => {
  show('login');
});

// Intercept room join callback by wrapping
function wireRoomEntry(roomMeta) {
  currentRoom = roomMeta;
  $('room-title').textContent = `${roomMeta.name} (${roomMeta.mode === 'ttt' ? 'Tic-Tac-Toe' : 'Koop'})`;
  $('ttt-area').classList.toggle('hidden', roomMeta.mode !== 'ttt');
  $('coop-area').classList.toggle('hidden', roomMeta.mode !== 'coop');
  $('room-chat').innerHTML = '';
  show('room');
}

const _emit = socket.emit;
socket.emit = function(event, ...args) {
  if (event === 'room:join' && typeof args[args.length - 1] === 'function') {
    const origCb = args[args.length - 1];
    args[args.length - 1] = (res) => {
      if (res.ok) wireRoomEntry(res.room);
      origCb(res);
    };
  }
  return _emit.apply(this, [event, ...args]);
};

// Tic-Tac-Toe
const boardEl = $('ttt-board');
for (let i = 0; i < 9; i++) {
  const btn = document.createElement('button');
  btn.className = 'cell';
  btn.dataset.idx = i;
  btn.onclick = () => socket.emit('ttt:move', i);
  boardEl.appendChild(btn);
}

$('ttt-start').onclick = () => socket.emit('ttt:start');

socket.on('ttt:state', (state) => {
  const cells = boardEl.querySelectorAll('.cell');
  cells.forEach((c, i) => {
    c.textContent = state.board[i] || '';
    c.classList.toggle('win', state.winLine && state.winLine.includes(i));
    c.disabled = !state.started || !!state.board[i] || !!state.winner;
  });
  const meSymbol = (state.players.find(p => p.name === me) || {}).symbol;
  let status = '';
  if (state.winner === 'draw') status = 'Unentschieden!';
  else if (state.winner) status = `${state.winner} hat gewonnen!`;
  else if (!state.started) {
    status = state.players.length < 2 ? 'Warte auf zweiten Spieler…' : 'Bereit — auf "Neues Spiel" drücken.';
  } else {
    status = state.turn === meSymbol ? 'Du bist dran!' : `${state.turn} ist dran…`;
  }
  $('ttt-status').textContent = status;
  $('ttt-start').disabled = state.players.length < 2 || state.started;
});

// Coop
$('coop-start').onclick = () => socket.emit('coop:start');
$('coop-click').onclick = () => socket.emit('coop:click');

let coopTimerInterval = null;
socket.on('coop:state', (state) => {
  const pct = Math.min(100, (state.count / state.target) * 100);
  $('coop-bar').style.width = pct + '%';
  $('coop-click').disabled = !state.started || state.finished;
  $('coop-start').disabled = state.started || state.players.length < 2;
  if (coopTimerInterval) { clearInterval(coopTimerInterval); coopTimerInterval = null; }
  const setStatus = () => {
    if (state.finished) {
      $('coop-status').textContent = state.success
        ? `🎉 Geschafft: ${state.count}/${state.target}`
        : `⏰ Verloren: ${state.count}/${state.target}`;
      return;
    }
    if (!state.started) {
      $('coop-status').textContent = state.players.length < 2
        ? `Warte auf weitere Spieler (mind. 2)… Ziel: ${state.target}`
        : `Bereit. Ziel: ${state.target} Klicks in ${state.timeLimitMs / 1000}s.`;
      return;
    }
    const remaining = Math.max(0, state.timeLimitMs - (Date.now() - state.startedAt));
    $('coop-status').textContent = `${state.count}/${state.target} — ${(remaining / 1000).toFixed(1)}s übrig`;
  };
  setStatus();
  if (state.started && !state.finished) {
    coopTimerInterval = setInterval(setStatus, 100);
  }
});
