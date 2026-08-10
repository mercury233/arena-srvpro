"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ctos_send,
  decodePayload,
  stoc_send,
  stoc_send_chat_to_room,
  writePlayerName,
} = require("../ygopro.js");

function capturePacket(send) {
  let packet;
  send({
    closed: false,
    write(buffer) {
      assert.equal(packet, undefined);
      packet = Buffer.from(buffer);
    },
  });
  return packet;
}

test("decodes CTOS_JOIN_GAME using the YGOPro struct padding", () => {
  const payload = Buffer.alloc(48);
  payload.writeUInt16LE(0x1357, 0);
  payload.writeUInt16LE(0xffff, 2);
  payload.writeUInt32LE(0x89abcdef, 4);
  payload.write("M#123456789\0", 8, "utf16le");

  assert.deepEqual(decodePayload("CTOS", 0x12, payload), {
    version: 0x1357,
    gameid: 0x89abcdef,
    pass: "M#123456789",
  });
});

test("rewrites CTOS_PLAYER_INFO as a null-terminated 20-unit UTF-16LE field", () => {
  const payload = Buffer.alloc(42, 0xaa);
  payload.write("player$password", 0, "utf16le");

  writePlayerName(payload, "12345678901234567890");

  assert.deepEqual(decodePayload("CTOS", 0x10, payload), {
    name: "1234567890123456789",
  });
  assert.equal(payload.readUInt16LE(38), 0);
  assert.equal(payload.readUInt16LE(40), 0xaaaa);
});

test("decodes only the UPDATE_DECK counts needed for validation", () => {
  const payload = Buffer.alloc(8);
  payload.writeUInt32LE(60, 0);
  payload.writeUInt32LE(15, 4);

  assert.deepEqual(decodePayload("CTOS", 0x02, payload), {
    mainc: 60,
    sidec: 15,
  });
  assert.throws(
    () => decodePayload("CTOS", 0x02, payload.subarray(0, 7)),
    /CTOS_UPDATE_DECK requires at least 8 payload bytes/,
  );
});

test("decodes the one-byte kick and player-type hook payloads", () => {
  assert.deepEqual(decodePayload("CTOS", 0x24, Buffer.from([3])), { pos: 3 });
  assert.deepEqual(decodePayload("STOC", 0x13, Buffer.from([0x17])), {
    type: 0x17,
  });
  assert.throws(
    () => decodePayload("STOC", 0x13, Buffer.alloc(0)),
    /STOC_TYPE_CHANGE requires at least 1 payload bytes/,
  );
});

test("encodes STOC_ERROR_MSG with the native three-byte padding", () => {
  const packet = capturePacket((socket) =>
    stoc_send(socket, "ERROR_MSG", { msg: 4, code: 0x12345678 }),
  );

  assert.equal(packet.readUInt16LE(0), 9);
  assert.equal(packet.readUInt8(2), 0x02);
  assert.equal(packet.readUInt8(3), 4);
  assert.deepEqual(packet.subarray(4, 7), Buffer.alloc(3));
  assert.equal(packet.readUInt32LE(7), 0x12345678);
});

test("encodes STOC_CHAT as a bounded variable-length UTF-16LE string", () => {
  const packet = capturePacket((socket) =>
    stoc_send(socket, "CHAT", { player: 11, msg: "a".repeat(300) }),
  );

  assert.equal(packet.readUInt16LE(0), packet.length - 2);
  assert.equal(packet.readUInt8(2), 0x19);
  assert.equal(packet.readUInt16LE(3), 11);
  assert.equal(packet.length, 3 + 2 + 256 * 2);
  assert.equal(packet.readUInt16LE(packet.length - 2), 0);
  assert.equal(packet.toString("utf16le", 5, packet.length - 2), "a".repeat(255));
});

test("ctos_send frames a raw Buffer payload", () => {
  const payload = Buffer.from([0x12, 0x34, 0x56]);
  const packet = capturePacket((socket) =>
    ctos_send(socket, "RESPONSE", payload),
  );

  assert.equal(packet.readUInt16LE(0), payload.length + 1);
  assert.equal(packet.readUInt8(2), 0x01);
  assert.deepEqual(packet.subarray(3), payload);
});

test("ctos_send encodes the server-mode full-information observer handshake", () => {
  const playerInfo = capturePacket((socket) =>
    ctos_send(socket, "PLAYER_INFO", { name: "Marshtomp" }),
  );
  const joinGame = capturePacket((socket) =>
    ctos_send(socket, "JOIN_GAME", {
      version: 0x1357,
      pass: "Marshtomp",
    }),
  );

  assert.equal(playerInfo.length, 43);
  assert.deepEqual(decodePayload("CTOS", 0x10, playerInfo.subarray(3)), {
    name: "Marshtomp",
  });
  assert.equal(joinGame.length, 51);
  assert.deepEqual(joinGame.subarray(5, 7), Buffer.alloc(2));
  assert.deepEqual(decodePayload("CTOS", 0x12, joinGame.subarray(3)), {
    version: 0x1357,
    gameid: 0,
    pass: "Marshtomp",
  });
});

test("room chat reaches halfway watchers and can exclude the joining client", () => {
  const createClient = () => ({
    closed: false,
    lang: "zh-cn",
    writes: [],
    write(buffer) {
      this.writes.push(Buffer.from(buffer));
    },
  });
  const player = createClient();
  const existingWatcher = createClient();
  const joiningWatcher = createClient();
  const room = {
    players: [player],
    observerStream: {
      watchers: new Set([existingWatcher, joiningWatcher]),
    },
  };

  stoc_send_chat_to_room(room, "joined", 8, joiningWatcher);

  assert.equal(player.writes.length, 1);
  assert.equal(existingWatcher.writes.length, 1);
  assert.equal(joiningWatcher.writes.length, 0);
});
