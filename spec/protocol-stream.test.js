"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { consumePackets } = require("../ygopro.js");

function createPacket(proto, payload = Buffer.alloc(0)) {
  const packet = Buffer.alloc(payload.length + 3);
  packet.writeUInt16LE(payload.length + 1, 0);
  packet.writeUInt8(proto, 2);
  payload.copy(packet, 3);
  return packet;
}

test("consumePackets retains fragmented packets and emits complete packets in order", () => {
  const first = createPacket(16, Buffer.from([1, 2, 3]));
  const second = createPacket(18, Buffer.from([4, 5]));
  const received = [];
  const protos = [];
  let pending = Buffer.alloc(0);

  const feed = (data) => {
    pending = pending.length ? Buffer.concat([pending, data]) : data;
    pending = consumePackets(pending, (packet, proto) => {
      received.push(Buffer.from(packet));
      protos.push(proto);
    });
  };

  feed(first.subarray(0, 1));
  assert.equal(received.length, 0);
  feed(Buffer.concat([first.subarray(1), second.subarray(0, 2)]));
  assert.deepEqual(received, [first]);
  assert.deepEqual(pending, second.subarray(0, 2));
  feed(second.subarray(2));

  assert.deepEqual(received, [first, second]);
  assert.deepEqual(protos, [16, 18]);
  assert.equal(pending.length, 0);
});

test("consumePackets rejects a zero-length frame", () => {
  assert.throws(
    () => consumePackets(Buffer.from([0, 0]), () => {}),
    /protocol byte/,
  );
});
