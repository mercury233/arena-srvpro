"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const ygopro = require("../ygopro.js");
const { RoomRegistry } = require("../room-registry.js");
const { RoomObserverStream } = require("../room-observer-stream.js");

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.remoteAddress = "127.0.0.1";
    this.destroyed = false;
    this.writes = [];
  }
  write(buffer) {
    this.writes.push(Buffer.from(buffer));
    return true;
  }
  setTimeout(value) {
    this.timeout = value;
  }
  setKeepAlive(value) {
    this.keepAlive = value;
  }
  end() {
    this.endCalled = true;
    this.emit("finish");
  }
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      queueMicrotask(() => this.emit("close"));
    }
  }
}

// Load the actual lifecycle classes without starting listeners or a duel process.
const source = fs.readFileSync(require.resolve("../index.js"), "utf8");
const lifecycleSource = source.slice(
  source.indexOf("class Room {"),
  source.indexOf("net.createServer((client) =>"),
);

function setup() {
  const registry = new RoomRegistry();
  const sessions = new WeakMap();
  const { Room, PlayerSession } = vm.runInNewContext(
    `${lifecycleSource}\n({ Room, PlayerSession });`,
    {
      Buffer, Set, net: { Socket: FakeSocket },
      ygopro: { ...ygopro, stoc_send_chat() {} },
      ROOM_all: registry, SOCKET_sessions: sessions,
      getSession: (socket) => sessions.get(socket),
      settings: { modules: {} },
      log: { warn() {} },
      setTimeout, clearTimeout, ROOM_CLOSE_DRAIN_TIMEOUT_MS: 1000,
    },
  );
  const room = Object.assign(Object.create(Room.prototype), {
    name: "M#123", lifecycle: "running", players: [], scores: {},
    hostinfo: { mode: 0 }, process: { exitCode: 0 },
  });
  registry.add(room);
  const observer = new FakeSocket();
  room.observerStream = new RoomObserverStream(1, {
    connect: () => observer,
    onEnd: () => room.observerStreamEnded(),
  });
  room.observerStream.start(12345);
  const packets = new FakeSocket();
  ygopro.stoc_send(packets, "JOIN_GAME");
  ygopro.stoc_send(packets, "DUEL_END");
  observer.emit("data", packets.writes[0]);
  const watcher = new FakeSocket();
  const session = new PlayerSession(watcher);
  session.start();
  session.attach(room, true);
  room.observerStream.addWatcher(watcher);
  return { room, registry, sessions, observer, watcher, session, tail: packets.writes[1] };
}

for (const reason of ["server-exit", "empty"]) {
  for (const observerFirst of [true, false]) {
    test(`completed watcher survives ${reason}, observer first: ${observerFirst}`, async () => {
      const { room, registry, sessions, observer, watcher, session, tail } = setup();
      observer.emit("data", tail);
      if (!observerFirst) room.close(reason);
      observer.emit("close");
      if (observerFirst) room.close(reason);
      await Promise.resolve();

      assert.equal(room.lifecycle, "closed");
      assert.equal(registry.size, 0);
      assert.equal(room.observerStream.buffers.length, 0);
      assert.equal(room.observerStream.watchers.size, 0);
      assert.equal(watcher.destroyed, false);
      assert.equal(watcher.endCalled, undefined);
      assert.equal(watcher.timeout, 0);
      assert.equal(watcher.keepAlive, true);
      assert.equal(session.room, undefined);
      assert.equal(session.serverClosed, true);
      assert.equal(session.playbackPending, true);

      watcher.emit("data", Buffer.from([0, 0]));
      assert.equal(session.preEstablishBuffers.length, 0);
      assert.equal(watcher.destroyed, false);
      watcher.destroy();
      await Promise.resolve();
      assert.equal(session.terminated, true);
      assert.equal(sessions.has(watcher), false);
      assert.equal(sessions.has(session.server), false);
    });
  }
}

for (const scenario of ["admin-kick", "missing-end", "partial-end", "trailing-partial", "observer-error", "drain-timeout"]) {
  test(`watcher closes on ${scenario}`, async () => {
    const { room, observer, watcher, session, tail } = setup();
    if (scenario === "partial-end") {
      observer.emit("data", tail.subarray(0, 2));
    } else if (scenario !== "missing-end") {
      observer.emit("data", tail);
    }
    if (scenario === "trailing-partial") observer.emit("data", Buffer.from([1]));
    if (scenario === "observer-error") observer.emit("error", new Error("broken"));
    if (scenario !== "drain-timeout") observer.emit("close");
    room.close(scenario === "admin-kick" ? "admin-kick" : "server-exit");
    if (scenario === "drain-timeout") room.finalizeClose();
    await Promise.resolve();

    assert.equal(room.lifecycle, "closed");
    assert.equal(watcher.destroyed, true);
    assert.equal(session.terminated, true);
  });
}
