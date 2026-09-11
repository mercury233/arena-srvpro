"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");

const { RoomObserverStream } = require("../room-observer-stream.js");
const { decodePayload, stoc_send } = require("../ygopro.js");

class FakeSocket extends EventEmitter {
  constructor(options = {}) {
    super();
    this.closed = false;
    this.destroyed = false;
    this.writableFinished = false;
    this.finishOnEnd = options.finishOnEnd !== false;
    this.endCalled = false;
    this.writes = [];
  }

  write(buffer) {
    this.writes.push(Buffer.from(buffer));
    return true;
  }

  destroy() {
    this.closed = true;
    this.destroyed = true;
  }

  end() {
    this.endCalled = true;
    if (this.finishOnEnd) {
      this.finish();
    }
  }

  finish() {
    this.writableFinished = true;
    this.emit("finish");
  }
}

function makeObserverJoinPacket() {
  const socket = new FakeSocket();
  stoc_send(socket, "JOIN_GAME");
  return socket.writes[0];
}

test("observer stream joins the core as the full-information observer", async () => {
  const observer = new FakeSocket();
  let connection;
  let readyCount = 0;
  const stream = new RoomObserverStream(0x2468, {
    connect(port, host, onConnect) {
      connection = { port, host };
      queueMicrotask(onConnect);
      return observer;
    },
    onReady() {
      readyCount++;
    },
  });

  assert.equal(stream.start(12345), true);
  assert.equal(stream.start(12345), false);
  await Promise.resolve();

  assert.deepEqual(connection, { port: 12345, host: "127.0.0.1" });
  assert.equal(observer.writes.length, 2);
  assert.deepEqual(
    decodePayload("CTOS", observer.writes[0][2], observer.writes[0].subarray(3)),
    { name: "Marshtomp" },
  );
  assert.deepEqual(
    decodePayload("CTOS", observer.writes[1][2], observer.writes[1].subarray(3)),
    { version: 0x2468, gameid: 0, pass: "Marshtomp" },
  );
  assert.equal(stream.isJoining(), true);
  assert.equal(stream.addWatcher(new FakeSocket()), false);

  const joinPacket = makeObserverJoinPacket();
  observer.emit("data", joinPacket.subarray(0, 2));
  assert.equal(stream.isJoining(), true);
  assert.equal(readyCount, 0);
  observer.emit("data", joinPacket.subarray(2));
  assert.equal(stream.isJoining(), false);
  assert.equal(readyCount, 1);
  stream.close();
});

test("observer stream sends cached data and then forwards live data", async () => {
  const observer = new FakeSocket();
  const stream = new RoomObserverStream(1, {
    connect(port, host, onConnect) {
      queueMicrotask(onConnect);
      return observer;
    },
  });
  const firstWatcher = new FakeSocket();
  const secondWatcher = new FakeSocket();
  const first = makeObserverJoinPacket();
  const cachedFirst = Buffer.from(first);
  const second = Buffer.from([3, 4]);
  const third = Buffer.from([5, 6]);

  stream.start(12345);
  await Promise.resolve();
  observer.emit("data", first);
  assert.equal(stream.addWatcher(firstWatcher), true);
  first.fill(0);
  observer.emit("data", second);
  assert.deepEqual(firstWatcher.writes, [cachedFirst, second]);

  assert.equal(stream.removeWatcher(firstWatcher), true);
  observer.emit("data", third);
  assert.equal(stream.addWatcher(secondWatcher), true);
  assert.deepEqual(secondWatcher.writes, [cachedFirst, second, third]);

  assert.deepEqual(stream.close(), [secondWatcher]);
  assert.equal(observer.destroyed, true);
  assert.equal(stream.addWatcher(new FakeSocket()), false);
});

test("observer stream rejects watchers and closes existing ones after observer failure", () => {
  const observer = new FakeSocket();
  const errors = [];
  let endCount = 0;
  const stream = new RoomObserverStream(1, {
    connect() {
      return observer;
    },
    onError(error) {
      errors.push(error);
    },
    onEnd() {
      endCount++;
    },
  });
  const watcher = new FakeSocket();
  const error = new Error("connection lost");

  assert.equal(stream.start(12345), true);
  observer.emit("data", makeObserverJoinPacket());
  assert.equal(stream.addWatcher(watcher), true);
  observer.emit("error", error);
  observer.emit("close");

  assert.deepEqual(errors, [error]);
  assert.equal(endCount, 1);
  assert.equal(stream.hasPendingDrain(), false);
  assert.equal(watcher.destroyed, true);
  assert.equal(stream.addWatcher(new FakeSocket()), false);
  assert.deepEqual(stream.close(), [watcher]);
});

test("observer stream reports synchronous connection failure and cannot restart", () => {
  const error = new Error("connect failed");
  const errors = [];
  const stream = new RoomObserverStream(1, {
    connect() {
      throw error;
    },
    onError(failure) {
      errors.push(failure);
    },
  });

  assert.equal(stream.start(12345), false);
  assert.deepEqual(errors, [error]);
  assert.equal(stream.start(12345), false);
  assert.equal(stream.addWatcher(new FakeSocket()), false);
});

test("observer stream times out while the TCP connection remains pending", async () => {
  const observer = new FakeSocket();
  const errors = [];
  let endCount = 0;
  const stream = new RoomObserverStream(1, {
    connect() {
      return observer;
    },
    joinTimeoutMs: 10,
    onError(error) {
      errors.push(error);
    },
    onEnd() {
      endCount++;
    },
  });

  assert.equal(stream.start(12345), true);
  assert.equal(stream.isJoining(), true);
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.match(errors[0].message, /did not connect and join/);
  assert.equal(endCount, 1);
  assert.equal(observer.destroyed, true);
  assert.equal(stream.isJoining(), false);
  assert.equal(stream.hasPendingDrain(), false);
});

test("observer stream releases startup when observer closes before joining", () => {
  const observer = new FakeSocket();
  const errors = [];
  let endCount = 0;
  const stream = new RoomObserverStream(1, {
    connect() {
      return observer;
    },
    onError(error) {
      errors.push(error);
    },
    onEnd() {
      endCount++;
    },
  });

  assert.equal(stream.start(12345), true);
  assert.equal(stream.isJoining(), true);
  observer.destroyed = true;
  observer.closed = true;
  observer.emit("close");

  assert.match(errors[0].message, /closed before JOIN_GAME/);
  assert.equal(endCount, 1);
  assert.equal(stream.isJoining(), false);
  assert.equal(stream.hasPendingDrain(), false);
});

test("observer stream finishes without ending watcher connections after DUEL_END", () => {
  const observer = new FakeSocket();
  const errors = [];
  let endCount = 0;
  const stream = new RoomObserverStream(1, {
    connect() {
      return observer;
    },
    onError(error) {
      errors.push(error);
    },
    onEnd() {
      endCount++;
    },
  });
  const fastWatcher = new FakeSocket();
  const slowWatcher = new FakeSocket({ finishOnEnd: false });
  const joinPacket = makeObserverJoinPacket();

  assert.equal(stream.start(12345), true);
  assert.equal(stream.hasPendingDrain(), true);
  observer.emit("data", joinPacket);
  assert.equal(stream.addWatcher(fastWatcher), true);
  assert.equal(stream.addWatcher(slowWatcher), true);
  const packets = new FakeSocket();
  stoc_send(packets, "DUEL_END");
  const tail = packets.writes[0];
  observer.emit("data", tail.subarray(0, 2));
  assert.equal(stream.duelEnded, false);
  observer.emit("data", tail.subarray(2));
  assert.equal(stream.duelEnded, true);
  assert.equal(stream.packetBuffer.length, 0);
  observer.destroyed = true;
  observer.closed = true;
  observer.emit("close");

  assert.deepEqual(errors, []);
  assert.equal(endCount, 1);
  assert.equal(stream.hasPendingDrain(), false);
  assert.equal(fastWatcher.endCalled, false);
  assert.equal(slowWatcher.endCalled, false);
  assert.equal(slowWatcher.destroyed, false);
  slowWatcher.finish();
  assert.equal(endCount, 1);
  assert.equal(stream.hasPendingDrain(), false);
  assert.equal(slowWatcher.destroyed, false);
  assert.deepEqual(Buffer.concat(fastWatcher.writes), Buffer.concat([joinPacket, tail]));
  assert.deepEqual(Buffer.concat(slowWatcher.writes), Buffer.concat([joinPacket, tail]));
  assert.equal(stream.addWatcher(new FakeSocket()), false);
  assert.deepEqual(stream.close(), [fastWatcher, slowWatcher]);
  assert.equal(slowWatcher.destroyed, false);
});
