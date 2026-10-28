// Simulação de uma partida completa entre dois clientes para validar o servidor.
const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const outcomes = new Set();
let failures = 0;

function check(cond, label) {
  if (cond) console.log(`  ✅ ${label}`);
  else { failures++; console.error(`  ❌ ${label}`); }
}

function connect(name) {
  const socket = io(URL);
  socket.name = name;
  socket.state = null;
  socket.on('update', (s) => (socket.state = s));
  return socket;
}

const emit = (sock, ev, data) =>
  new Promise((res) => sock.emit(ev, data, res));

const waitFor = (sock, pred, timeout = 3000) =>
  new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (sock.state && pred(sock.state)) { clearInterval(iv); resolve(sock.state); }
      else if (Date.now() - t0 > timeout) { clearInterval(iv); reject(new Error('timeout esperando estado')); }
    }, 25);
  });

async function playRandomMove(sock, color) {
  // acha uma peça da vez com movimentos legais e joga
  const fen = sock.state.fen;
  const rows = fen.split(' ')[0].split('/');
  const squares = [];
  rows.forEach((row, r) => {
    let c = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) c += +ch;
      else {
        const isWhite = ch === ch.toUpperCase();
        if ((color === 'w') === isWhite) squares.push('abcdefgh'[c] + (8 - r));
        c++;
      }
    }
  });
  for (const from of squares.sort(() => Math.random() - 0.5)) {
    const moves = await emit(sock, 'getMoves', from);
    if (moves.length) {
      const to = moves[Math.floor(Math.random() * moves.length)].to;
      return await emit(sock, 'moveIntent', { from, to });
    }
  }
  return { ok: false, error: 'sem movimentos' };
}

(async () => {
  console.log('1. Conectando jogadores...');
  const A = connect('Alice');
  const B = connect('Beto');
  await new Promise((r) => setTimeout(r, 500));

  console.log('2. Alice cria sala...');
  const created = await emit(A, 'createRoom', { name: 'Alice' });
  check(created.ok && created.code.length === 4 && created.color === 'w', `sala criada: ${created.code}`);

  console.log('2b. Listando salas disponíveis...');
  const list1 = await emit(B, 'listRooms');
  const mine = list1.find((r) => r.code === created.code);
  check(Array.isArray(list1) && mine && mine.status === 'waiting' && mine.host === 'Alice', 'sala de Alice aparece como aguardando');

  console.log('3. Beto entra com código errado (deve falhar)...');
  const bad = await emit(B, 'joinRoom', { code: 'XXXX', name: 'Beto' });
  check(!bad.ok, 'código inválido rejeitado');

  console.log('4. Beto entra na sala certa...');
  const joined = await emit(B, 'joinRoom', { code: created.code, name: 'Beto' });
  check(joined.ok && joined.color === 'b', 'Beto entrou como Pretas');
  await waitFor(A, (s) => s.status === 'playing');
  check(A.state.players.w === 'Alice' && A.state.players.b === 'Beto', 'ambos veem os dois jogadores');
  const list2 = await emit(B, 'listRooms');
  check(list2.find((r) => r.code === created.code).status === 'playing', 'sala cheia aparece como em jogo');

  console.log('5. Terceiro cliente vira espectador...');
  const C = connect('Carlos');
  await new Promise((r) => setTimeout(r, 300));
  const spec = await emit(C, 'joinRoom', { code: created.code, name: 'Carlos' });
  check(spec.ok && spec.color === 'spectator', 'terceiro entra como espectador');
  const specMove = await emit(C, 'moveIntent', { from: 'e2', to: 'e4' });
  check(!specMove.ok, 'espectador não pode mover');

  console.log('6. Beto tenta jogar fora de vez (deve falhar)...');
  const wrongTurn = await emit(B, 'moveIntent', { from: 'e7', to: 'e5' });
  check(!wrongTurn.ok, 'jogada fora do turno rejeitada');

  console.log('7. Alice tenta lance ilegal (deve falhar sem rolar dado)...');
  const illegal = await emit(A, 'moveIntent', { from: 'e2', to: 'e5' });
  check(!illegal.ok, 'lance ilegal rejeitado');

  console.log('8. Alice pede movimentos de e2...');
  const moves = await emit(A, 'getMoves', 'e2');
  check(moves.length === 2 && moves.some((m) => m.to === 'e4'), 'e2 tem 2 lances legais (e3, e4)');

  console.log('9. Jogando partida aleatória até acabar ou 300 lances...');
  let lastFen = A.state.fen;
  for (let i = 0; i < 300; i++) {
    const st = A.state;
    if (st.status === 'over') break;
    const turn = st.turn;
    const sock = turn === 'w' ? A : B;
    const before = st.fen;
    const res = await playRandomMove(sock, turn);
    if (!res.ok) { console.error('  ❌ lance falhou:', res.error); failures++; break; }
    await waitFor(A, (s) => (s.roll && s.fen !== before) || s.status === 'over', 3000).catch(() => {});
    await new Promise((r) => setTimeout(r, 30));
    const roll = A.state.roll;
    if (roll) outcomes.add(roll.outcome);
    // turno deve ter alternado, exceto em crítico
    if (roll && roll.outcome !== 'crit' && A.state.status !== 'over' && A.state.turn === turn) {
      failures++;
      console.error(`  ❌ turno não alternou após outcome=${roll.outcome}`);
      break;
    }
    if (roll && roll.outcome === 'crit' && A.state.status !== 'over' && A.state.turn !== turn) {
      failures++;
      console.error('  ❌ crítico não concedeu turno extra');
      break;
    }
    lastFen = A.state.fen;
  }
  console.log(`  Outcomes observados: ${[...outcomes].join(', ') || 'nenhum'}`);
  check(outcomes.size >= 2, 'dado produziu resultados variados');
  console.log(`  Status final: ${A.state.status} ${A.state.result ? JSON.stringify(A.state.result) : ''}`);
  console.log(`  FEN final: ${lastFen}`);

  console.log('10. Reiniciando partida...');
  await emit(A, 'restart', {});
  await waitFor(A, (s) => s.status === 'playing' && s.fen.startsWith('rnbqkbnr/pppppppp'));
  check(true, 'partida reiniciada para posição inicial');

  console.log('11. Desconexão de Beto...');
  B.disconnect();
  await waitFor(A, (s) => s.players.b === null && s.status === 'waiting');
  check(true, 'saída de Beto notificada e vaga liberada');

  A.disconnect(); C.disconnect();
  console.log(failures === 0 ? '\n🎉 TODOS OS TESTES PASSARAM' : `\n💥 ${failures} FALHA(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERRO FATAL:', e); process.exit(1); });
