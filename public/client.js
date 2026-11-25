/* global io */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);
  const COLORS = ['var(--p0)', 'var(--p1)', 'var(--p2)', 'var(--p3)'];

  function makeStore(area) {
    return {
      get(key) { try { return window[area].getItem(key); } catch { return null; } },
      set(key, val) { try { window[area].setItem(key, val); } catch { /* ignore */ } },
    };
  }
  // Name is remembered across tabs; the player ID is per tab (survives reloads,
  // but two tabs in one browser are two different players).
  const store = makeStore('localStorage');
  const tabStore = makeStore('sessionStorage');

  const socket = io({ auth: { playerId: tabStore.get('memory.playerId') } });
  let me = tabStore.get('memory.playerId');
  let state = null;

  // ---------- helpers ----------
  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function send(event, payload = {}) {
    return new Promise((resolve) => {
      socket.emit(event, payload, (res) => {
        if (!res?.ok) toast(res?.error || 'Something went wrong.');
        resolve(res || { ok: false });
      });
    });
  }

  function playerName() {
    const name = $('#name').value.trim();
    store.set('memory.name', name);
    return name;
  }

  function colorOf(id) {
    const i = state ? state.players.findIndex((p) => p.id === id) : -1;
    return COLORS[Math.max(0, i) % COLORS.length];
  }

  function setUrlRoom(code) {
    const url = new URL(location.href);
    if (code) url.searchParams.set('room', code); else url.searchParams.delete('room');
    history.replaceState(null, '', url);
  }

  function show(screen) {
    ['home', 'lobby', 'game'].forEach((s) => { $(`#screen-${s}`).hidden = s !== screen; });
  }

  function playerRow(p, { showScore = false } = {}) {
    const li = document.createElement('li');
    if (!p.connected) li.classList.add('offline');
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colorOf(p.id);
    const name = document.createElement('span');
    name.textContent = p.name;
    li.append(dot, name);
    if (p.id === state.hostId) li.append(tag('host', 'Host'));
    if (p.id === me) li.append(tag('', 'You'));
    if (!p.connected) li.append(tag('', 'Offline'));
    if (showScore) {
      const s = document.createElement('span');
      s.className = 'score';
      s.textContent = p.score;
      li.append(s);
    }
    return li;
  }

  function tag(cls, text) {
    const t = document.createElement('span');
    t.className = `tag ${cls}`.trim();
    t.textContent = text;
    return t;
  }

  // ---------- rendering ----------
  function render() {
    if (!state) { show('home'); return; }
    if (state.status === 'lobby') renderLobby();
    else renderGame();
  }

  function renderLobby() {
    show('lobby');
    const isHost = state.hostId === me;
    const connected = state.players.filter((p) => p.connected).length;
    $('#lobby-code').textContent = state.code;
    $('#player-count').textContent = `(${state.players.length}/4)`;
    $('#lobby-players').replaceChildren(...state.players.map((p) => playerRow(p)));
    $('#host-controls').hidden = !isHost;
    $('#guest-wait').hidden = isHost;
    $('#btn-start').disabled = connected < 2;
    $('#start-hint').textContent = connected < 2 ? 'Share the code — you need at least 2 players.' : '';
  }

  let boardKey = '';
  function renderGame() {
    show('game');
    $('#game-code').textContent = state.code;

    // Turn banner
    const banner = $('#turn-banner');
    const turnPlayer = state.players.find((p) => p.id === state.turnId);
    const myTurn = state.turnId === me && state.status === 'playing';
    banner.classList.toggle('you', myTurn);
    if (state.status === 'over') banner.textContent = 'Game over!';
    else if (myTurn) banner.textContent = state.locked ? 'No match…' : 'Your turn!';
    else banner.textContent = turnPlayer ? `${turnPlayer.name}'s turn` : '';

    // Scoreboard
    $('#scoreboard').replaceChildren(...state.players.map((p) => {
      const li = playerRow(p, { showScore: true });
      li.classList.toggle('active', p.id === state.turnId);
      return li;
    }));

    // Board: rebuild only when a new game starts, otherwise update in place.
    const board = $('#board');
    const key = `${state.cards.length}:${gameId}`;
    if (key !== boardKey) {
      boardKey = key;
      board.style.setProperty('--cols', state.cols);
      board.style.setProperty('--rows', state.rows);
      // Center a short last row (34 cards in rows of 6 leaves 4 at the bottom).
      const lastRow = state.cards.length % state.cols;
      const lastRowStart = state.cards.length - lastRow;
      const offset = Math.floor((state.cols - lastRow) / 2);
      board.replaceChildren(...state.cards.map((_, i) => {
        const btn = document.createElement('button');
        btn.className = 'card';
        btn.dataset.index = i;
        if (lastRow && i === lastRowStart && offset) btn.style.gridColumnStart = offset + 1;
        btn.innerHTML = '<div class="card-inner"><div class="face back"><span class="back-mark"></span></div>'
          + '<div class="face front"><img alt="" draggable="false"></div></div>';
        return btn;
      }));
      preloadCards();
    }
    const canFlip = myTurn && !state.locked;
    state.cards.forEach((c, i) => {
      const btn = board.children[i];
      btn.classList.toggle('up', c.state === 'up');
      btn.classList.toggle('matched', c.state === 'matched');
      btn.disabled = !canFlip || c.state !== 'down';
      btn.setAttribute('aria-label', c.state === 'down' ? `Card ${i + 1}, face down` : `Card ${i + 1}, ${c.name}`);
      const img = btn.querySelector('.front img');
      // Keep the old face while turning back over so it doesn't vanish mid-flip.
      if (c.value && img.dataset.id !== c.value) {
        img.dataset.id = c.value;
        img.src = `/cards/${c.value}.webp`;
      }
      if (c.matchedBy) btn.style.setProperty('--owner', colorOf(c.matchedBy));
    });

    renderGameOver();
  }

  function renderGameOver() {
    const overlay = $('#game-over');
    overlay.hidden = state.status !== 'over';
    if (overlay.hidden) return;
    const ranked = [...state.players].sort((a, b) => b.score - a.score);
    const top = ranked[0].score;
    const winners = ranked.filter((p) => p.score === top);
    let text;
    if (winners.length > 1) text = `It's a tie! (${winners.map((w) => w.name).join(' & ')})`;
    else if (winners[0].id === me) text = '🎉 You win!';
    else text = `${winners[0].name} wins!`;
    $('#winner-text').textContent = text;
    $('#final-scores').replaceChildren(...ranked.map((p) => playerRow(p, { showScore: true })));
    const isHost = state.hostId === me;
    $('#rematch-controls').hidden = !isHost;
    $('#rematch-wait').hidden = isHost;
  }

  // Warm the cache so a flipped card shows its art immediately. Every game uses
  // the full set, so loading them all reveals nothing about where they are.
  let preloaded = false;
  function preloadCards() {
    if (preloaded) return;
    preloaded = true;
    fetch('/cards.json').then((r) => r.json()).then((cards) => {
      cards.forEach(({ id }) => { new Image().src = `/cards/${id}.webp`; });
    }).catch(() => {});
  }

  // Bump when a fresh game begins so the board is rebuilt with new cards.
  let gameId = 0;
  let lastStatus = null;

  // ---------- socket events ----------
  socket.on('session', ({ playerId, code }) => {
    me = playerId;
    tabStore.set('memory.playerId', playerId);
    // The server no longer knows our room (e.g. it restarted): go home.
    if (!code && state) {
      state = null;
      setUrlRoom(null);
      toast('That room has closed.');
      render();
    }
  });

  socket.on('state', (next) => {
    if (next.status === 'playing' && lastStatus !== 'playing') gameId++;
    lastStatus = next.status;
    state = next;
    setUrlRoom(state.code);
    render();
  });

  socket.on('disconnect', () => toast('Connection lost — reconnecting…'));
  socket.io.on('reconnect', () => toast('Reconnected.'));

  // ---------- UI events ----------
  $('#btn-create').addEventListener('click', () => {
    send('create', { name: playerName() });
  });

  $('#join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('#code').value.trim();
    if (code.length !== 4) { toast('Room codes are 4 letters.'); return; }
    send('join', { code, name: playerName() });
  });

  $('#code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '');
  });

  $('#btn-start').addEventListener('click', () => send('start'));
  $('#btn-rematch').addEventListener('click', () => send('start'));

  $('#board').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (!card || card.disabled) return;
    send('flip', { index: Number(card.dataset.index) });
  });

  $$('.btn-leave').forEach((btn) => btn.addEventListener('click', async () => {
    await send('leave');
    state = null;
    lastStatus = null;
    setUrlRoom(null);
    render();
  }));

  $('#btn-copy').addEventListener('click', async () => {
    const url = `${location.origin}/?room=${state.code}`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Invite link copied!');
    } catch {
      toast(url);
    }
  });

  // ---------- init ----------
  $('#name').value = store.get('memory.name') || '';
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) $('#code').value = roomParam.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  render();
})();
