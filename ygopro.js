"use strict";

const fs = require("fs");
const { Struct } = require("./struct.js");

const loadJSON = (file) =>
  JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

const i18ns = loadJSON("./data/i18n.json");
const i18nR = {};

for (const [lang, translations] of Object.entries(i18ns)) {
  i18nR[lang] = {};
  for (const [key, translation] of Object.entries(translations)) {
    i18nR[lang][key] = {
      regex: new RegExp(`\\$\\{${key}\\}`, "g"),
      text: translation,
    };
  }
}

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

const stoc_follows = {};
const ctos_follows = {};

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
  client.system_kicked = true;
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
  replace_proto,
  stoc_follow,
  ctos_follow,
  stoc_send,
  ctos_send,
  stoc_send_chat,
  stoc_send_chat_to_room,
  stoc_die,
};
