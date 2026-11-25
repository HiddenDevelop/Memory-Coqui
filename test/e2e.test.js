'use strict';

// Two socket clients create/join a room by code and play a full match.
process.env.MISMATCH_DELAY_MS = '20';

const test = require('node:test');
const assert = require('node:assert');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server');

function call(sock, event, payload) {
  return new Promise((resolve) => sock.emit(event, payload, resolve));
}

function nextState(sock, pred = () => true) {
  return new Promise((resolve) => {
    const onState = (s) => { if (pred(s)) { sock.off('state', onState); resolve(s); } };
    sock.on('state', onState);
  });
}

test('full match over sockets using a room code', async () => {
  const { server, rooms } = createServer();
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}`;
  const a = connect(url, { transports: ['websocket'] });
  const b = connect(url, { transports: ['websocket'] });
  try {
    const created = await call(a, 'create', { name: 'Ana' });
    assert.ok(created.ok);
    assert.match(created.code, /^[A-Z]{4}$/);

    const bad = await call(b, 'join', { code: 'ZZZZ', name: 'Beto' });
    if (!rooms.has('ZZZZ')) assert.strictEqual(bad.ok, false);

    const joined = await call(b, 'join', { code: created.code.toLowerCase(), name: 'Beto' });
    assert.ok(joined.ok);

    const notHost = await call(b, 'start');
    assert.strictEqual(notHost.ok, false);

    const started = nextState(a, (s) => s.status === 'playing');
    assert.ok((await call(a, 'start')).ok);
    let state = await started;
    assert.strictEqual(state.cards.length, 34);

    // The test peeks at the server deck to know where pairs are.
    const room = rooms.get(created.code);
    const socketFor = (id) => (room.players[0].id === id ? a : b);

    // First, force one mismatch to check the turn passes.
    const first = socketFor(state.turnId);
    const firstTurn = state.turnId;
    const v0 = room.cards[0].value;
    const wrong = room.cards.findIndex((c) => c.value !== v0);
    await call(first, 'flip', { index: 0 });
    const res = await call(first, 'flip', { index: wrong });
    assert.strictEqual(res.result, 'mismatch');
    state = await nextState(a, (s) => !s.locked);
    assert.notStrictEqual(state.turnId, firstTurn);

    // Then clear the board.
    while (room.status === 'playing') {
      const sock = socketFor(room.currentPlayer.id);
      const i = room.cards.findIndex((c) => c.state === 'down');
      const j = room.cards.findIndex((c, k) => k !== i && c.value === room.cards[i].value);
      await call(sock, 'flip', { index: i });
      await call(sock, 'flip', { index: j });
    }
    assert.strictEqual(room.status, 'over');
    const total = room.players.reduce((s, p) => s + p.score, 0);
    assert.strictEqual(total, 17);

    // Rematch from the game-over screen.
    const re = await call(a, 'start');
    assert.ok(re.ok);
    assert.strictEqual(room.cards.length, 34);
  } finally {
    a.close();
    b.close();
    await new Promise((r) => server.close(r));
  }
});
