"use strict";

const fs = require("fs");
const { Struct } = require("./struct.js");
const { i18ns, i18nR } = require("./utility.js");

const loadJSON = (file) =>
  JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

const structsDeclaration = loadJSON("./data/structs.json");
const typedefs = loadJSON("./data/typedefs.json");
const proto_structs = loadJSON("./data/proto_structs.json");
const constants = loadJSON("./data/constants.json");
const structs = {};

for (const [name, declaration] of Object.entries(structsDeclaration)) {
  const result = Struct();

  for (const field of declaration) {
    if (field.encoding) {
      if (field.encoding !== "UTF-16LE") {
        throw new Error(`unsupported encoding: ${field.encoding}`);
      }
      result.chars(field.name, field.length * 2, field.encoding);
      continue;
    }

    const type = typedefs[field.type] || field.type;
    if (field.length) {
      result.array(field.name, field.length, type);
    } else if (structs[type]) {
      result.struct(field.name, structs[type]);
    } else {
      result[type](field.name);
    }
  }

  structs[name] = result;
}

const stoc_follows = new Array(256);
const ctos_follows = new Array(256);
const MAX_PACKETS_PER_READ = 800;
const EMPTY_BUFFER = Buffer.alloc(0);

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

function sendPacket(socket, type, proto, info) {
  if (socket.closed) {
    return;
  }

  let buffer;
  if (typeof info === "undefined") {
    buffer = Buffer.alloc(0);
  } else if (Buffer.isBuffer(info)) {
    buffer = info;
  } else {
    const struct = structs[proto_structs[type][proto]];
    struct.allocate();
    struct.set(info);
    buffer = struct.buffer();
  }

  const resolvedProto = replace_proto(proto, type);
  const header = Buffer.allocUnsafe(3);
  header.writeUInt16LE(buffer.length + 1, 0);
  header.writeUInt8(resolvedProto, 2);
  socket.write(header);
  if (buffer.length) {
    socket.write(buffer);
  }
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
  proto_structs,
  constants,
  structs,
  stoc_follows,
  ctos_follows,
  processPackets,
  replace_proto,
  stoc_follow,
  ctos_follow,
  stoc_send,
  ctos_send,
  stoc_send_chat,
  stoc_send_chat_to_room,
  stoc_die,
};
