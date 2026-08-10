"use strict";

const fs = require("fs");
const { i18ns, i18nR } = require("./utility.js");

const loadJSON = (file) =>
  JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

const constants = loadJSON("./data/constants.json");

const stoc_follows = new Array(256);
const ctos_follows = new Array(256);
const MAX_PACKETS_PER_READ = 800;
const EMPTY_BUFFER = Buffer.alloc(0);
const PLAYER_NAME_CODE_UNITS = 20;
const PLAYER_NAME_BYTES = PLAYER_NAME_CODE_UNITS * 2;
const CHAT_MESSAGE_CODE_UNITS = 256;

function requirePayloadLength(buffer, minimum, protocol) {
  if (buffer.length < minimum) {
    throw new Error(
      `${protocol} requires at least ${minimum} payload bytes, got ${buffer.length}`,
    );
  }
}

function readFixedUtf16LE(buffer, offset, codeUnits) {
  const end = offset + codeUnits * 2;
  let stringEnd = end;
  for (let position = offset; position < end; position += 2) {
    if (buffer.readUInt16LE(position) === 0) {
      stringEnd = position;
      break;
    }
  }
  return buffer.toString("utf16le", offset, stringEnd);
}

function trimUtf16CodeUnits(value, maximum) {
  let result = String(value).slice(0, maximum);
  const lastCodeUnit = result.charCodeAt(result.length - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
    result = result.slice(0, -1);
  }
  return result;
}

// Offsets include the native C++ padding asserted by gframe/network.h.
const payloadDecoders = {
  CTOS: {
    PLAYER_INFO(buffer) {
      requirePayloadLength(buffer, PLAYER_NAME_BYTES, "CTOS_PLAYER_INFO");
      return { name: readFixedUtf16LE(buffer, 0, PLAYER_NAME_CODE_UNITS) };
    },
    JOIN_GAME(buffer) {
      requirePayloadLength(buffer, 48, "CTOS_JOIN_GAME");
      return {
        version: buffer.readUInt16LE(0),
        gameid: buffer.readUInt32LE(4),
        pass: readFixedUtf16LE(buffer, 8, PLAYER_NAME_CODE_UNITS),
      };
    },
    HS_KICK(buffer) {
      requirePayloadLength(buffer, 1, "CTOS_HS_KICK");
      return { pos: buffer.readUInt8(0) };
    },
    UPDATE_DECK(buffer) {
      requirePayloadLength(buffer, 8, "CTOS_UPDATE_DECK");
      return {
        mainc: buffer.readUInt32LE(0),
        sidec: buffer.readUInt32LE(4),
      };
    },
  },
  STOC: {
    TYPE_CHANGE(buffer) {
      requirePayloadLength(buffer, 1, "STOC_TYPE_CHANGE");
      return { type: buffer.readUInt8(0) };
    },
  },
};

const payloadEncoders = {
  CTOS: {},
  STOC: {
    ERROR_MSG(info) {
      const buffer = Buffer.alloc(8);
      buffer.writeUInt8(info.msg, 0);
      buffer.writeUInt32LE(info.code, 4);
      return buffer;
    },
    CHAT(info) {
      const msg = trimUtf16CodeUnits(info.msg, CHAT_MESSAGE_CODE_UNITS - 1);
      const buffer = Buffer.alloc(2 + (msg.length + 1) * 2);
      buffer.writeUInt16LE(info.player, 0);
      buffer.write(msg, 2, "utf16le");
      return buffer;
    },
  },
};

function processPackets(buffer, follows, callback) {
  let offset = 0;
  let forwardingStart = 0;
  let forwarding = null;
  let packetCount = 0;

  while (buffer.length - offset >= 2) {
    const messageLength = buffer[offset] | (buffer[offset + 1] << 8);
    if (messageLength < 1) {
      throw new Error("packet length does not include a protocol byte");
    }

    const packetLength = messageLength + 2;
    if (buffer.length - offset < packetLength) {
      break;
    }
    if (++packetCount > MAX_PACKETS_PER_READ) {
      throw new Error("too many packets in one read");
    }

    const packetEnd = offset + packetLength;
    const proto = buffer[offset + 2];
    const follow = follows[proto];
    if (
      follow &&
      callback(buffer.subarray(offset + 3, packetEnd), proto, follow)
    ) {
      if (forwardingStart < offset) {
        const segment = buffer.subarray(forwardingStart, offset);
        if (forwarding == null) {
          forwarding = segment;
        } else if (Buffer.isBuffer(forwarding)) {
          forwarding = [forwarding, segment];
        } else {
          forwarding.push(segment);
        }
      }
      forwardingStart = packetEnd;
    }
    offset = packetEnd;
  }

  if (forwardingStart < offset) {
    const segment =
      forwardingStart === 0 && offset === buffer.length
        ? buffer
        : buffer.subarray(forwardingStart, offset);
    if (forwarding == null) {
      forwarding = segment;
    } else if (Buffer.isBuffer(forwarding)) {
      forwarding = [forwarding, segment];
    } else {
      forwarding.push(segment);
    }
  }

  return {
    forwarding,
    remaining:
      offset === 0
        ? buffer
        : offset === buffer.length
          ? EMPTY_BUFFER
          : Buffer.from(buffer.subarray(offset)),
  };
}

function replace_proto(proto, type) {
  if (typeof proto !== "string") {
    return proto;
  }

  let changedProto = proto;
  for (const [key, value] of Object.entries(constants[type])) {
    if (value === proto) {
      changedProto = key;
      break;
    }
  }

  if (!constants[type][changedProto]) {
    throw new Error(`unknown ${type} proto: ${proto}`);
  }
  return changedProto;
}

function stoc_follow(proto, synchronous, callback) {
  stoc_follows[replace_proto(proto, "STOC")] = { callback, synchronous };
}

function ctos_follow(proto, synchronous, callback) {
  ctos_follows[replace_proto(proto, "CTOS")] = { callback, synchronous };
}

function decodePayload(type, proto, buffer) {
  const protocolName = constants[type][proto];
  const decoder = payloadDecoders[type][protocolName];
  return decoder ? decoder(buffer) : null;
}

function writePlayerName(buffer, name) {
  requirePayloadLength(buffer, PLAYER_NAME_BYTES, "CTOS_PLAYER_INFO");
  buffer.fill(0, 0, PLAYER_NAME_BYTES);
  buffer.write(
    trimUtf16CodeUnits(name, PLAYER_NAME_CODE_UNITS - 1),
    0,
    (PLAYER_NAME_CODE_UNITS - 1) * 2,
    "utf16le",
  );
}

function sendPacket(socket, type, proto, info) {
  if (socket.closed) {
    return;
  }

  const resolvedProto = replace_proto(proto, type);
  let payload;
  if (typeof info === "undefined") {
    payload = EMPTY_BUFFER;
  } else if (Buffer.isBuffer(info)) {
    payload = info;
  } else {
    const protocolName = constants[type][resolvedProto];
    const encoder = payloadEncoders[type][protocolName];
    if (!encoder) {
      throw new Error(`no ${type} payload encoder for ${protocolName}`);
    }
    payload = encoder(info);
  }

  const packet = Buffer.allocUnsafe(payload.length + 3);
  packet.writeUInt16LE(payload.length + 1, 0);
  packet.writeUInt8(resolvedProto, 2);
  payload.copy(packet, 3);
  socket.write(packet);
}

function stoc_send(socket, proto, info) {
  sendPacket(socket, "STOC", proto, info);
}

function ctos_send(socket, proto, info) {
  sendPacket(socket, "CTOS", proto, info);
}

function stoc_send_chat(client, msg, player = 8) {
  if (!client) {
    console.log("err stoc_send_chat");
    return;
  }

  const lines = msg == null ? [] : String(msg).split(/\r\n?|\n/);
  for (let line of lines) {
    if (player >= 10) {
      line = `[Server]: ${line}`;
    }
    for (const replacement of Object.values(i18nR[client.lang])) {
      line = line.replace(replacement.regex, replacement.text);
    }
    stoc_send(client, "CHAT", { player, msg: line });
  }
}

function stoc_send_chat_to_room(room, msg, player = 8) {
  if (!room) {
    console.log("err stoc_send_chat_to_room");
    return;
  }

  for (const client of room.players) {
    if (client) {
      stoc_send_chat(client, msg, player);
    }
  }
}

function stoc_die(client, msg) {
  stoc_send_chat(client, msg, constants.COLORS.RED);
  if (!client) {
    return;
  }

  stoc_send(client, "ERROR_MSG", { msg: 1, code: 9 });
  client.destroy();
}

module.exports = {
  i18ns,
  i18nR,
  constants,
  stoc_follows,
  ctos_follows,
  processPackets,
  replace_proto,
  stoc_follow,
  ctos_follow,
  decodePayload,
  writePlayerName,
  stoc_send,
  ctos_send,
  stoc_send_chat,
  stoc_send_chat_to_room,
  stoc_die,
};
