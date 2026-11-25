'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Room, GameError, normalizeCode, randomCode } = require('../src/game');

function setup() {
  const room = new Room('ABCD', { rng: () => 0 });
  room.addPlayer('a', 'Ana');
  room.addPlayer('b', 'Beto');
  room.start('a');
  return room;
}

function pairOf(room, index) {
  const v = room.cards[index].value;
  return room.cards.findIndex((c, i) => i !== index && c.value === v);
}

function nonPairOf(room, index) {
  const v = room.cards[index].value;
  return room.cards.findIndex((c, i) => i !== index && c.value !== v && c.state === 'down');
}

test('room codes use 4 letters without lookalikes', () => {
  for (let i = 0; i < 200; i++) assert.match(randomCode(), /^[A-HJ-NP-Z]{4}$/);
  assert.strictEqual(normalizeCode(' ab-cd9 '), 'ABCD');
});

test('first player is host; host can only start with 2+ players', () => {
  const room = new Room('ABCD');
  room.addPlayer('a', 'Ana');
  assert.strictEqual(room.hostId, 'a');
  assert.throws(() => room.start('a'), GameError);
  room.addPlayer('b', 'Beto');
  assert.throws(() => room.start('b'), /Only the host/);
  room.start('a');
  assert.strictEqual(room.cards.length, 34);
});

test('room is full at 4 and closed once a game starts', () => {
  const room = new Room('ABCD');
  ['a', 'b', 'c', 'd'].forEach((id) => room.addPlayer(id, id));
  assert.throws(() => room.addPlayer('e', 'e'), /full/);
  room.removePlayer('d');
  room.start('a');
  assert.throws(() => room.addPlayer('e', 'e'), /already started/);
  // Existing players can rejoin a running game.
  room.addPlayer('a', 'Ana');
});

test('deck is 17 pairs, every symbol exactly twice', () => {
  const room = setup();
  const counts = {};
  room.cards.forEach((c) => { counts[c.value] = (counts[c.value] || 0) + 1; });
  assert.strictEqual(Object.keys(counts).length, 17);
  assert.ok(Object.values(counts).every((n) => n === 2));
});

test('public state hides face-down values', () => {
  const room = setup();
  assert.ok(room.publicState().cards.every((c) => c.value === null));
  room.flip(room.currentPlayer.id, 0);
  const cards = room.publicState().cards;
  assert.ok(cards[0].value);
  assert.ok(cards.slice(1).every((c) => c.value === null));
});

test('a match scores and keeps the turn; a mismatch passes it', () => {
  const room = setup();
  const p = room.currentPlayer.id;
  assert.throws(() => room.flip(p === 'a' ? 'b' : 'a', 0), /not your turn/);

  room.flip(p, 0);
  assert.throws(() => room.flip(p, 0), /already face up/);
  assert.strictEqual(room.flip(p, pairOf(room, 0)).type, 'match');
  assert.strictEqual(room.getPlayer(p).score, 1);
  assert.strictEqual(room.currentPlayer.id, p);

  const i = room.cards.findIndex((c) => c.state === 'down');
  room.flip(p, i);
  assert.strictEqual(room.flip(p, nonPairOf(room, i)).type, 'mismatch');
  assert.throws(() => room.flip(p, nonPairOf(room, i)), /Wait/);
  room.resolveMismatch();
  assert.notStrictEqual(room.currentPlayer.id, p);
  assert.strictEqual(room.cards.filter((c) => c.state === 'up').length, 0);
});

test('game ends when all pairs are found', () => {
  const room = setup();
  let last;
  while (room.status === 'playing') {
    const p = room.currentPlayer.id;
    const i = room.cards.findIndex((c) => c.state === 'down');
    room.flip(p, i);
    last = room.flip(p, pairOf(room, i));
  }
  assert.strictEqual(last.type, 'over');
  assert.strictEqual(room.players.reduce((s, p) => s + p.score, 0), 17);
});

test('disconnect on your turn passes the turn and moves host', () => {
  const room = setup();
  const p = room.currentPlayer.id;
  room.flip(p, 0);
  room.setConnected(p, false);
  assert.notStrictEqual(room.currentPlayer.id, p);
  assert.strictEqual(room.cards[0].state, 'down');
  room.setConnected('a', false);
  room.setConnected('b', true);
  assert.strictEqual(room.hostId, 'b');
});
