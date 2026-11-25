'use strict';

// Room code alphabet without lookalikes (no I, O, 0, 1).
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_LENGTH = 4;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const NAME_MAX = 16;

// The coquí card art, built by `npm run build:cards` from public/coqui-images.
// Each entry is { id, name }; the image lives at public/cards/<id>.webp.
const CARDS = require('./cards.json');
const CARD_NAMES = Object.fromEntries(CARDS.map((c) => [c.id, c.name]));

// Every game uses 17 pairs (34 cards), laid out 6 wide: five full rows plus a centered row of 4.
const PAIRS = 17;
const COLS = 6;
const ROWS = Math.ceil((PAIRS * 2) / COLS);

if (CARDS.length < PAIRS) {
  throw new Error(`Need at least ${PAIRS} card images, found ${CARDS.length}. Run npm run build:cards.`);
}
const SYMBOLS = CARDS.map((c) => c.id);

function randomCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function normalizeCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, CODE_LENGTH);
}

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return n || 'Player';
}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

class GameError extends Error {}

class Room {
  constructor(code, { rng = Math.random } = {}) {
    this.code = code;
    this.rng = rng;
    this.players = []; // { id, name, score, connected }
    this.hostId = null;
    this.status = 'lobby'; // lobby | playing | over
    this.cards = []; // { value, state: 'down' | 'up' | 'matched', matchedBy }
    this.turnIndex = 0;
    this.open = []; // indexes of face-up, unmatched cards
    this.locked = false; // true while a mismatch is showing
    this.lastActive = Date.now();
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id) || null;
  }

  get currentPlayer() {
    return this.players[this.turnIndex] || null;
  }

  touch() {
    this.lastActive = Date.now();
  }

  addPlayer(id, name) {
    const existing = this.getPlayer(id);
    if (existing) {
      existing.connected = true;
      if (name) existing.name = cleanName(name);
      return existing;
    }
    if (this.status !== 'lobby') throw new GameError('That game has already started.');
    if (this.players.length >= MAX_PLAYERS) throw new GameError('That room is full.');
    const player = { id, name: cleanName(name), score: 0, connected: true };
    this.players.push(player);
    if (!this.hostId) this.hostId = id;
    this.touch();
    return player;
  }

  // Leaving in the lobby frees the seat; leaving mid-game keeps the score on the board.
  removePlayer(id) {
    const idx = this.players.findIndex((p) => p.id === id);
    if (idx === -1) return;
    if (this.status === 'playing') {
      this.setConnected(id, false);
      this.players[idx].left = true;
    } else {
      this.players.splice(idx, 1);
      if (this.turnIndex >= this.players.length) this.turnIndex = 0;
    }
    this.reassignHost();
    this.touch();
  }

  setConnected(id, connected) {
    const player = this.getPlayer(id);
    if (!player) return;
    player.connected = connected;
    if (connected) player.left = false;
    this.reassignHost();
    // If the active player drops, put any lone open card back and pass the turn.
    if (!connected && this.status === 'playing' && this.currentPlayer?.id === id && !this.locked) {
      this.hideOpen();
      this.advanceTurn();
    }
    this.touch();
  }

  reassignHost() {
    const host = this.getPlayer(this.hostId);
    if (host && host.connected) return;
    const next = this.players.find((p) => p.connected);
    if (next) this.hostId = next.id;
    else if (!host) this.hostId = null;
  }

  get connectedCount() {
    return this.players.filter((p) => p.connected).length;
  }

  start(byId) {
    if (byId !== this.hostId) throw new GameError('Only the host can start the game.');
    if (this.status === 'playing') throw new GameError('The game is already running.');
    // Players who left during the last game give up their seat on a rematch.
    this.players = this.players.filter((p) => !p.left);
    if (this.connectedCount < MIN_PLAYERS) {
      throw new GameError(`You need at least ${MIN_PLAYERS} players to start.`);
    }
    const symbols = shuffle(SYMBOLS.slice(), this.rng).slice(0, PAIRS);
    const deck = shuffle([...symbols, ...symbols], this.rng);
    this.cards = deck.map((value) => ({ value, state: 'down', matchedBy: null }));
    this.players.forEach((p) => { p.score = 0; });
    this.open = [];
    this.locked = false;
    this.status = 'playing';
    this.turnIndex = Math.floor(this.rng() * this.players.length);
    if (!this.currentPlayer.connected) this.advanceTurn();
    this.touch();
  }

  // Returns { type: 'first' | 'match' | 'mismatch' | 'over' }.
  flip(byId, index) {
    if (this.status !== 'playing') throw new GameError('The game is not running.');
    if (this.locked) throw new GameError('Wait for the cards to turn back over.');
    if (this.currentPlayer?.id !== byId) throw new GameError("It's not your turn.");
    const card = this.cards[index];
    if (!Number.isInteger(index) || !card) throw new GameError('That card does not exist.');
    if (card.state !== 'down') throw new GameError('That card is already face up.');

    card.state = 'up';
    this.open.push(index);
    this.touch();
    if (this.open.length === 1) return { type: 'first' };

    const [a, b] = this.open.map((i) => this.cards[i]);
    if (a.value === b.value) {
      a.state = b.state = 'matched';
      a.matchedBy = b.matchedBy = byId;
      this.currentPlayer.score += 1;
      this.open = [];
      if (this.cards.every((c) => c.state === 'matched')) {
        this.status = 'over';
        return { type: 'over' };
      }
      return { type: 'match' };
    }
    this.locked = true;
    return { type: 'mismatch' };
  }

  // Called by the server after the mismatch delay.
  resolveMismatch() {
    if (!this.locked) return;
    this.hideOpen();
    this.locked = false;
    this.advanceTurn();
  }

  hideOpen() {
    this.open.forEach((i) => { this.cards[i].state = 'down'; });
    this.open = [];
  }

  advanceTurn() {
    const n = this.players.length;
    for (let step = 1; step <= n; step++) {
      const i = (this.turnIndex + step) % n;
      if (this.players[i].connected) {
        this.turnIndex = i;
        return;
      }
    }
  }

  // Everyone sees the same state; face values are only sent for face-up cards.
  publicState() {
    return {
      code: this.code,
      status: this.status,
      rows: ROWS,
      cols: COLS,
      hostId: this.hostId,
      turnId: this.status === 'playing' ? this.currentPlayer?.id ?? null : null,
      locked: this.locked,
      players: this.players.map(({ id, name, score, connected }) => ({ id, name, score, connected })),
      cards: this.cards.map((c) => ({
        state: c.state,
        value: c.state === 'down' ? null : c.value,
        name: c.state === 'down' ? null : CARD_NAMES[c.value],
        matchedBy: c.matchedBy,
      })),
    };
  }
}

module.exports = {
  Room,
  GameError,
  PAIRS,
  SYMBOLS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  randomCode,
  normalizeCode,
  cleanName,
};
