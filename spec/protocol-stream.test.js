"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { processPackets } = require("../ygopro.js");

function createPacket(proto, payload = Buffer.alloc(0)) {
  const packet = Buffer.alloc(payload.length + 3);
  packet.writeUInt16LE(payload.length + 1, 0);
  packet.writeUInt8(proto, 2);
  payload.copy(packet, 3);
  return packet;
}

function combineForwarding(forwarding) {
  if (!forwarding) {
    return Buffer.alloc(0);
  }
  return Buffer.isBuffer(forwarding)
    ? forwarding
    : Buffer.concat(forwarding);
}

test("processPackets forwards an unhooked batch without per-packet callbacks", () => {
  const input = Buffer.concat([
    createPacket(1, Buffer.from([1, 2, 3])),
    createPacket(2, Buffer.from([4, 5])),
  ]);

  const result = processPackets(input, [], () => {
    throw new Error("unhooked packet invoked callback");
  });

  assert.equal(result.forwarding, input);
  assert.equal(result.remaining.length, 0);
});

test("processPackets retains a fragmented frame and forwards completed data", () => {
  const first = createPacket(16, Buffer.from([1, 2, 3]));
  const second = createPacket(18, Buffer.from([4, 5]));
  const input = Buffer.concat([first, second.subarray(0, 2)]);

  const result = processPackets(input, [], () => {});

  assert.deepEqual(result.forwarding, first);
  assert.deepEqual(result.remaining, second.subarray(0, 2));
});

test("a non-canceling hook can modify its payload without splitting forwarding", () => {
  const input = Buffer.concat([
    createPacket(1, Buffer.from([1])),
    createPacket(18, Buffer.from([2, 3])),
    createPacket(2, Buffer.from([4])),
  ]);
  const follows = [];
  follows[18] = {};
  let hookCount = 0;

  const result = processPackets(input, follows, (payload, proto) => {
    hookCount++;
    assert.equal(proto, 18);
    payload[0] = 9;
    return false;
  });

  assert.equal(hookCount, 1);
  assert.equal(result.forwarding, input);
  assert.equal(input[7], 9);
});

test("a canceled packet splits only the surrounding forwarding ranges", () => {
  const first = createPacket(1, Buffer.from([1]));
  const canceled = createPacket(18, Buffer.from([2]));
  const last = createPacket(2, Buffer.from([3]));
  const input = Buffer.concat([first, canceled, last]);
  const follows = [];
  follows[18] = {};

  const result = processPackets(input, follows, () => true);

  assert.ok(Array.isArray(result.forwarding));
  assert.equal(result.forwarding.length, 2);
  assert.deepEqual(combineForwarding(result.forwarding), Buffer.concat([first, last]));
  assert.equal(result.remaining.length, 0);
});

test("processPackets rejects a zero-length frame", () => {
  assert.throws(
    () => processPackets(Buffer.from([0, 0]), [], () => {}),
    /protocol byte/,
  );
});
