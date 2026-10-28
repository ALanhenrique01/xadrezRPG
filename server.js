const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// code -> { game, players: { w: {id,name}|null, b: {id,name}|null }, log: [], seq: 0 }
const rooms = new Map();

const PIECE_NAMES = { p: 'Peão', n: 'Cavalo', b: 'Bispo', r: 'Torre', q: 'Dama', k: 'Rei' };

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// Passa o turno sem mover (usado nas punições). Limpa en passant para manter o FEN válido.
function flipTurn(game) {
  const parts = game.fen().split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-';
  game.load(parts.join(' '));
}

function countKings(game) {
  let w = 0, b = 0;
  for (const row of game.board()) {
    for (const c of row) {
      if (c && c.type === 'k') c.color === 'w' ? w++ : b++;
    }
  }
  return { w, b };
}

function getResult(game) {
  const kings = countKings(game);
  if (kings.w === 0) return { winner: 'b', reason: 'O rei branco foi destruído!' };
  if (kings.b === 0) return { winner: 'w', reason: 'O rei preto foi destruído!' };
  if (game.isCheckmate()) return { winner: game.turn() === 'w' ? 'b' : 'w', reason: 'Xeque-mate!' };
  if (game.isStalemate()) return { winner: null, reason: 'Empate por afogamento (stalemate)' };
  if (game.isDraw()) return { winner: null, reason: 'Empate' };
  return null;
}

function playerColor(room, socketId) {
  if (room.players.w && room.players.w.id === socketId) return 'w';
  if (room.players.b && room.players.b.id === socketId) return 'b';
  return null;
}

function publicState(room, code) {
  const result = getResult(room.game);
  return {
    code,
    fen: room.game.fen(),
    turn: room.game.turn(),
    players: {
      w: room.players.w ? room.players.w.name : null,
      b: room.players.b ? room.players.b.name : null,
    },
    status: !room.players.w || !room.players.b ? 'waiting' : result ? 'over' : 'playing',
    result,
    check: !result && room.game.inCheck(),
    roll: room.lastRoll || null,
    log: room.log.slice(-50),
  };
}

function pushLog(room, text) {
  room.log.push(text);
  if (room.log.length > 200) room.log.shift();
}

function broadcast(room, code) {
  io.to(code).emit('update', publicState(room, code));
}

function resolveMove(room, code, color, from, to) {
  const game = room.game;
  const name = room.players[color].name;

  const intended = game.moves({ square: from, verbose: true }).find((m) => m.to === to);
  if (!intended) return { ok: false, error: 'Movimento ilegal.' };
  const needsPromotion = intended.flags.includes('p');

  const roll = 1 + Math.floor(Math.random() * 20);
  let outcome, text, applied = null;

  const tryMove = (target) => {
    try {
      const mv = game.move({ from, to: target, promotion: needsPromotion ? 'q' : undefined });
      return mv || null;
    } catch {
      return null;
    }
  };

  if (roll === 20) {
    outcome = 'crit';
    const mv = tryMove(to);
    applied = { from, to };
    text = `🎲 20 — CRÍTICO! ${name} jogou ${mv.san} e ganhou um turno extra!`;
  } else if (roll === 1) {
    outcome = 'disaster';
    const piece = game.get(from);
    game.remove(from);
    text = `🎲 1 — DESASTRE! ${PIECE_NAMES[piece.type]} de ${name} em ${from} foi destruído!`;
  } else if (roll >= 13) {
    outcome = 'success';
    const mv = tryMove(to);
    applied = { from, to };
    text = `🎲 ${roll} — Sucesso! ${name} jogou ${mv.san}`;
  } else {
    // Lado oposto: espelha o deslocamento
    outcome = 'opposite';
    const f1 = from.charCodeAt(0) - 97, r1 = from.charCodeAt(1) - 49;
    const f2 = to.charCodeAt(0) - 97, r2 = to.charCodeAt(1) - 49;
    const mf = 2 * f1 - f2, mr = 2 * r1 - r2;
    let mv = null;
    if (mf >= 0 && mf < 8 && mr >= 0 && mr < 8) {
      const mirrored = String.fromCharCode(97 + mf) + (mr + 1);
      mv = tryMove(mirrored);
      if (mv) applied = { from, to: mirrored };
    }
    text = mv
      ? `🎲 ${roll} — Falha! A peça de ${name} foi para o LADO OPOSTO: ${mv.san}`
      : `🎲 ${roll} — Falha! A peça de ${name} se recusou a mover e perdeu o turno`;
  }

  let result = getResult(game);

  // Aplica a passagem de turno quando nenhum lance válido aconteceu,
  // ou devolve o turno no crítico (se o jogo não acabou).
  if (!result) {
    if (outcome === 'crit') {
      flipTurn(game);
    } else if (!applied) {
      flipTurn(game);
    }
    result = getResult(game);
  }

  room.seq++;
  room.lastRoll = { seq: room.seq, value: roll, outcome, text, by: color, applied };
  pushLog(room, text);
  if (result) pushLog(room, `🏁 ${result.reason}${result.winner ? ` Vitória de ${room.players[result.winner] ? room.players[result.winner].name : result.winner}!` : ''}`);
  broadcast(room, code);
  return { ok: true };
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;

  socket.on('listRooms', (data, cb) => {
    if (typeof data === 'function') { cb = data; }
    const list = [];
    for (const [code, room] of rooms) {
      list.push({
        code,
        host: room.players.w ? room.players.w.name : null,
        guest: room.players.b ? room.players.b.name : null,
        status: !room.players.w || !room.players.b ? 'waiting' : getResult(room.game) ? 'over' : 'playing',
      });
    }
    list.sort((a, b) => (a.status === 'waiting' ? 0 : 1) - (b.status === 'waiting' ? 0 : 1));
    if (typeof cb === 'function') cb(list);
  });

  socket.on('createRoom', ({ name }, cb) => {
    const code = makeCode();
    const room = { game: new Chess(), players: { w: { id: socket.id, name: name || 'Brancas' }, b: null }, log: [], seq: 0, lastRoll: null };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    pushLog(room, `${room.players.w.name} criou a sala ${code} (Brancas)`);
    cb({ ok: true, code, color: 'w' });
    broadcast(room, code);
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Sala não encontrada.' });

    let color = null;
    if (!room.players.b) color = 'b';
    else if (!room.players.w) color = 'w';

    if (color) {
      room.players[color] = { id: socket.id, name: name || (color === 'w' ? 'Brancas' : 'Pretas') };
      pushLog(room, `${room.players[color].name} entrou como ${color === 'w' ? 'Brancas' : 'Pretas'}`);
    } else {
      pushLog(room, `${name || 'Alguém'} entrou como espectador`);
    }
    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, code, color: color || 'spectator' });
    broadcast(room, code);
  });

  socket.on('getMoves', (square, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb([]);
    const color = playerColor(room, socket.id);
    if (!color || room.game.turn() !== color || getResult(room.game)) return cb([]);
    cb(room.game.moves({ square, verbose: true }).map((m) => ({ to: m.to, captured: !!m.captured })));
  });

  socket.on('moveIntent', ({ from, to }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb({ ok: false, error: 'Sala inexistente.' });
    const color = playerColor(room, socket.id);
    if (!color) return cb({ ok: false, error: 'Espectadores não jogam.' });
    if (!room.players.w || !room.players.b) return cb({ ok: false, error: 'Aguardando oponente.' });
    if (getResult(room.game)) return cb({ ok: false, error: 'A partida acabou.' });
    if (room.game.turn() !== color) return cb({ ok: false, error: 'Não é seu turno.' });
    cb(resolveMove(room, socket.data.roomCode, color, from, to));
  });

  socket.on('restart', (data, cb) => {
    if (typeof data === 'function') { cb = data; }
    const room = rooms.get(socket.data.roomCode);
    if (!room) return typeof cb === 'function' && cb({ ok: false });
    if (!playerColor(room, socket.id)) return typeof cb === 'function' && cb({ ok: false });
    room.game = new Chess();
    room.lastRoll = null;
    pushLog(room, '🔄 Partida reiniciada');
    broadcast(room, socket.data.roomCode);
    if (typeof cb === 'function') cb({ ok: true });
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    const room = code && rooms.get(code);
    if (!room) return;
    const color = playerColor(room, socket.id);
    if (color) {
      const name = room.players[color].name;
      room.players[color] = null;
      pushLog(room, `⚠️ ${name} (${color === 'w' ? 'Brancas' : 'Pretas'}) desconectou`);
    }
    if (!room.players.w && !room.players.b) {
      const stillAnyone = io.sockets.adapter.rooms.get(code);
      if (!stillAnyone || stillAnyone.size === 0) {
        rooms.delete(code);
        return;
      }
    }
    broadcast(room, code);
  });
});

server.listen(PORT, () => {
  console.log(`♞ Xadrez D20 rodando em http://localhost:${PORT}`);
});
