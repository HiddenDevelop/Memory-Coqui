'use strict';

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Room, GameError, randomCode, normalizeCode } = require('./src/game');

const MISMATCH_DELAY_MS = Number(process.env.MISMATCH_DELAY_MS) || 1200;
const EMPTY_ROOM_TTL_MS = 5 * 60 * 1000;
const PLAYER_ID_RE = /^[a-f0-9-]{36}$/;

function createServer() {
  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.get('/cards.json', (_req, res) => res.json(require('./src/cards.json')));

  const server = http.createServer(app);
  const io = new Server(server);

  const rooms = new Map(); // code -> Room
  const playerRoom = new Map(); // playerId -> code
  const timers = new Map(); // code -> mismatch timeout

  function newCode() {
    let code;
    do { code = randomCode(); } while (rooms.has(code));
    return code;
  }

  function broadcast(room) {
    io.to(room.code).emit('state', room.publicState());
  }

  function clearTimer(code) {
    clearTimeout(timers.get(code));
    timers.delete(code);
  }

  function leaveCurrentRoom(socket) {
    const { playerId } = socket.data;
    const code = playerRoom.get(playerId);
    if (!code) return;
    playerRoom.delete(playerId);
    socket.leave(code);
    const room = rooms.get(code);
    if (!room) return;
    room.removePlayer(playerId);
    if (room.players.length === 0) {
      clearTimer(code);
      rooms.delete(code);
    } else {
      broadcast(room);
    }
  }

  function enterRoom(socket, room, name) {
    const { playerId } = socket.data;
    if (playerRoom.get(playerId) !== room.code) leaveCurrentRoom(socket);
    room.addPlayer(playerId, name);
    playerRoom.set(playerId, room.code);
    socket.join(room.code);
    broadcast(room);
  }

  // Wrap a handler so thrown GameErrors go back to the caller's ack callback.
  function handler(socket, fn) {
    return (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        reply({ ok: true, ...(fn(payload || {}) || {}) });
      } catch (err) {
        if (!(err instanceof GameError)) console.error(err);
        reply({ ok: false, error: err instanceof GameError ? err.message : 'Something went wrong.' });
      }
    };
  }

  function roomOf(socket) {
    const room = rooms.get(playerRoom.get(socket.data.playerId));
    if (!room) throw new GameError("You're not in a room.");
    return room;
  }

  io.on('connection', (socket) => {
    const given = socket.handshake.auth?.playerId;
    socket.data.playerId = PLAYER_ID_RE.test(given || '') ? given : crypto.randomUUID();
    const { playerId } = socket.data;

    // Reconnect to the room this player was already in (page reload, network blip).
    const existing = rooms.get(playerRoom.get(playerId));
    const resumed = Boolean(existing && existing.getPlayer(playerId));
    socket.emit('session', { playerId, code: resumed ? existing.code : null });
    if (resumed) {
      existing.setConnected(playerId, true);
      socket.join(existing.code);
      broadcast(existing);
    }

    socket.on('create', handler(socket, ({ name }) => {
      const room = new Room(newCode());
      rooms.set(room.code, room);
      enterRoom(socket, room, name);
      return { code: room.code };
    }));

    socket.on('join', handler(socket, ({ code, name }) => {
      const room = rooms.get(normalizeCode(code));
      if (!room) throw new GameError('No room with that code.');
      enterRoom(socket, room, name);
      return { code: room.code };
    }));

    socket.on('start', handler(socket, () => {
      const room = roomOf(socket);
      clearTimer(room.code);
      room.start(playerId);
      broadcast(room);
    }));

    socket.on('flip', handler(socket, ({ index }) => {
      const room = roomOf(socket);
      const result = room.flip(playerId, index);
      broadcast(room);
      if (result.type === 'mismatch') {
        timers.set(room.code, setTimeout(() => {
          timers.delete(room.code);
          room.resolveMismatch();
          broadcast(room);
        }, MISMATCH_DELAY_MS));
      }
      return { result: result.type };
    }));

    socket.on('leave', handler(socket, () => {
      leaveCurrentRoom(socket);
    }));

    socket.on('disconnect', () => {
      const room = rooms.get(playerRoom.get(playerId));
      if (!room) return;
      // Another tab of the same player may still be connected.
      const stillHere = [...(io.sockets.adapter.rooms.get(room.code) || [])]
        .some((sid) => io.sockets.sockets.get(sid)?.data.playerId === playerId);
      if (stillHere) return;
      room.setConnected(playerId, false);
      broadcast(room);
    });
  });

  // Remove rooms nobody has been connected to for a while.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms) {
      if (room.connectedCount === 0 && now - room.lastActive > EMPTY_ROOM_TTL_MS) {
        clearTimer(code);
        room.players.forEach((p) => playerRoom.delete(p.id));
        rooms.delete(code);
      }
    }
  }, 60 * 1000);
  sweep.unref();

  return { app, server, io, rooms };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const { server } = createServer();
  server.listen(port, () => {
    console.log(`Memory Coqui running at http://localhost:${port}`);
  });
}

module.exports = { createServer };
