const socket = io();

const GLYPHS = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = 'abcdefgh';

let myColor = null; // 'w' | 'b' | 'spectator'
let roomCode = null;
let state = null;
let selected = null;
let legalTargets = [];
let lastRollSeq = 0;
let diceTimer = null;

const $ = (id) => document.getElementById(id);

// ---------- LOBBY ----------
let lobbyTimer = null;

function getName() {
  const name = $('playerName').value.trim();
  if (!name) {
    $('lobbyError').textContent = 'Digite seu nome primeiro.';
    $('playerName').focus();
    return null;
  }
  $('lobbyError').textContent = '';
  return name;
}

$('btnEnter').onclick = () => {
  if (!getName()) return;
  $('roomBrowser').classList.remove('hidden');
  $('btnEnter').classList.add('hidden');
  $('playerName').disabled = true;
  refreshRooms();
  clearInterval(lobbyTimer);
  lobbyTimer = setInterval(refreshRooms, 3000);
};

function refreshRooms() {
  socket.emit('listRooms', (rooms) => {
    const ul = $('roomList');
    ul.innerHTML = '';
    if (!rooms.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nenhuma sala aberta. Crie a primeira! ⬇️';
      ul.appendChild(li);
      return;
    }
    for (const room of rooms) {
      const li = document.createElement('li');
      const joinable = room.status === 'waiting';
      li.className = 'room-item' + (joinable ? '' : ' disabled');

      const info = document.createElement('div');
      const code = document.createElement('span');
      code.className = 'room-code';
      code.textContent = room.code;
      const players = document.createElement('div');
      players.className = 'room-players';
      players.textContent = room.status === 'waiting'
        ? `${room.host || room.guest} aguardando oponente`
        : `${room.host || '?'} vs ${room.guest || '?'}`;
      info.appendChild(code);
      info.appendChild(players);

      const badge = document.createElement('span');
      badge.className = 'badge ' + room.status;
      badge.textContent = room.status === 'waiting' ? 'Aguardando' : room.status === 'playing' ? 'Em jogo' : 'Finalizada';

      li.appendChild(info);
      li.appendChild(badge);
      if (joinable) li.onclick = () => joinRoom(room.code);
      else li.title = 'Sala cheia — entre como espectador pelo código';
      ul.appendChild(li);
    }
  });
}

$('btnRefresh').onclick = refreshRooms;

$('btnCreate').onclick = () => {
  const name = getName();
  if (!name) return;
  socket.emit('createRoom', { name }, (res) => {
    if (!res.ok) return ($('lobbyError').textContent = res.error || 'Erro ao criar sala.');
    enterGame(res.code, res.color);
  });
};

function joinRoom(code) {
  const name = getName();
  if (!name) return;
  socket.emit('joinRoom', { code, name }, (res) => {
    if (!res.ok) {
      $('lobbyError').textContent = res.error || 'Erro ao entrar.';
      refreshRooms();
      return;
    }
    enterGame(res.code, res.color);
  });
}

$('btnJoin').onclick = () => {
  const code = $('roomCode').value.trim();
  if (!code) return ($('lobbyError').textContent = 'Digite o código da sala.');
  joinRoom(code);
};

$('roomCode').addEventListener('keydown', (e) => e.key === 'Enter' && $('btnJoin').click());
$('playerName').addEventListener('keydown', (e) => e.key === 'Enter' && $('btnEnter').click());

function enterGame(code, color) {
  roomCode = code;
  myColor = color;
  clearInterval(lobbyTimer);
  $('lobby').classList.add('hidden');
  $('game').classList.remove('hidden');
  $('roomCodeLabel').textContent = code;
}

$('btnCopy').onclick = () => {
  navigator.clipboard.writeText(roomCode).then(() => {
    $('btnCopy').textContent = '✅';
    setTimeout(() => ($('btnCopy').textContent = '📋'), 1200);
  });
};
$('btnRestart').onclick = () => socket.emit('restart', () => {});
$('btnLeave').onclick = () => location.reload();

// ---------- ESTADO ----------
socket.on('update', (s) => {
  state = s;
  if (s.roll && s.roll.seq !== lastRollSeq) {
    lastRollSeq = s.roll.seq;
    animateDice(s.roll);
  }
  render();
});

function parseFen(fen) {
  const rows = fen.split(' ')[0].split('/');
  const board = [];
  for (const row of rows) {
    const cells = [];
    for (const ch of row) {
      if (/\d/.test(ch)) for (let i = 0; i < +ch; i++) cells.push(null);
      else cells.push({ type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' });
    }
    board.push(cells);
  }
  return board; // board[0] = rank 8
}

function squareName(row, col) {
  // row/col no sistema do FEN (row 0 = rank 8)
  return FILES[col] + (8 - row);
}

function render() {
  if (!state) return;
  renderBoard();
  renderSide();
}

function renderBoard() {
  const board = parseFen(state.fen);
  const flipped = myColor === 'b';
  const el = $('board');
  el.innerHTML = '';

  const applied = state.roll && state.roll.applied;

  for (let dr = 0; dr < 8; dr++) {
    for (let dc = 0; dc < 8; dc++) {
      const r = flipped ? 7 - dr : dr;
      const c = flipped ? 7 - dc : dc;
      const name = squareName(r, c);
      const sq = document.createElement('div');
      sq.className = 'square ' + ((r + c) % 2 === 0 ? 'light' : 'dark');
      sq.dataset.square = name;

      const piece = board[r][c];
      if (piece) {
        const span = document.createElement('span');
        span.className = 'piece ' + (piece.color === 'w' ? 'white' : 'black');
        span.textContent = GLYPHS[piece.type];
        sq.appendChild(span);
      }

      if (dc === 0) {
        const rank = document.createElement('span');
        rank.className = 'coord rank';
        rank.textContent = name[1];
        sq.appendChild(rank);
      }
      if (dr === 7) {
        const file = document.createElement('span');
        file.className = 'coord file';
        file.textContent = name[0];
        sq.appendChild(file);
      }

      if (selected === name) sq.classList.add('selected');
      if (applied && (applied.from === name || applied.to === name)) sq.classList.add('last-move');
      if (state.check && piece && piece.type === 'k' && piece.color === state.turn) sq.classList.add('in-check');

      const target = legalTargets.find((t) => t.to === name);
      if (target) {
        const hint = document.createElement('span');
        hint.className = target.captured ? 'ring' : 'dot';
        sq.appendChild(hint);
      }

      sq.onclick = () => onSquareClick(name, piece);
      el.appendChild(sq);
    }
  }
}

function renderSide() {
  const { players, turn, status, result } = state;
  const topColor = myColor === 'b' ? 'w' : 'b';
  const bottomColor = myColor === 'b' ? 'b' : 'w';
  const label = (color) => {
    const side = color === 'w' ? '♔ Brancas' : '♚ Pretas';
    const name = players[color] || 'aguardando...';
    const me = color === myColor ? ' (você)' : '';
    return `${side}: ${name}${me}`;
  };
  $('playerTop').textContent = label(topColor);
  $('playerBottom').textContent = myColor === 'spectator' ? '👀 Você é espectador' : label(bottomColor);
  $('playerTop').classList.toggle('active', turn === topColor && status === 'playing');
  $('playerBottom').classList.toggle('active', turn === bottomColor && status === 'playing' && myColor !== 'spectator');

  const st = $('statusText');
  st.className = 'status';
  if (status === 'waiting') {
    st.textContent = '⏳ Aguardando oponente... envie o código da sala!';
  } else if (status === 'over') {
    st.classList.add('over');
    const winnerName = result.winner ? players[result.winner] : null;
    st.textContent = `🏁 ${result.reason}` + (winnerName ? ` ${winnerName} venceu!` : '');
  } else {
    const mine = turn === myColor;
    st.textContent = mine ? '🎯 Sua vez!' : `Vez de ${players[turn] || '...'}`;
    st.classList.add(mine ? 'my-turn' : '');
    if (state.check) {
      st.textContent += ' — XEQUE!';
      st.classList.add('check');
    }
  }

  const log = $('log');
  log.innerHTML = '';
  for (let i = state.log.length - 1; i >= 0; i--) {
    const li = document.createElement('li');
    li.textContent = state.log[i];
    log.appendChild(li);
  }
}

// ---------- LANCES ----------
function onSquareClick(name, piece) {
  if (!state || state.status !== 'playing') return;
  if (myColor !== 'w' && myColor !== 'b') return;
  if (state.turn !== myColor) return;

  const target = legalTargets.find((t) => t.to === name);
  if (selected && target) {
    const from = selected;
    clearSelection();
    socket.emit('moveIntent', { from, to: name }, (res) => {
      if (!res.ok) console.warn(res.error);
    });
    return;
  }

  if (piece && piece.color === myColor) {
    selected = name;
    socket.emit('getMoves', name, (moves) => {
      if (selected !== name) return;
      legalTargets = moves;
      renderBoard();
    });
    renderBoard();
  } else {
    clearSelection();
  }
}

function clearSelection() {
  selected = null;
  legalTargets = [];
  renderBoard();
}

// ---------- DADO ----------
function animateDice(roll) {
  const dice = $('dice');
  const out = $('diceResult');
  clearInterval(diceTimer);
  dice.className = 'dice rolling';
  let ticks = 0;
  diceTimer = setInterval(() => {
    dice.textContent = 1 + Math.floor(Math.random() * 20);
    if (++ticks >= 14) {
      clearInterval(diceTimer);
      dice.textContent = roll.value;
      dice.className = 'dice ' + roll.outcome;
      out.textContent = roll.text;
    }
  }, 65);
}
