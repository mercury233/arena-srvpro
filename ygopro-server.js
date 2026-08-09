"use strict";

const net = require("net");
const http = require("http");
const url = require("url");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

const merge = require("deepmerge");

const logger = require("./logger.js");
const log = logger.createLogger({ name: "SRVPro" });

function loadJSON(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

// 配置
if (!fs.existsSync("./config")) {
  fs.mkdirSync("./config");
}

function setting_save(settings) {
  fs.writeFileSync(settings.file, JSON.stringify(settings, null, 2));
}

function setting_change(settings, path, val) {
  if (typeof val === "string") {
    // path should be like "modules:welcome"
    log.info("setting changed", path, val);
  }
  const keys = path.split(":");
  let target = settings;
  while (keys.length > 1) {
    const key = keys.shift();
    target = target[key];
  }
  const key = keys.shift();
  target[key] = val;
  setting_save(settings);
}

// 读取配置
const default_config = loadJSON("./data/default_config.json");
let config;
try {
  config = loadJSON("./config/config.json");
} catch {
  config = {};
}

const settings = merge(default_config, config, {
  arrayMerge: (destination, source) => source,
});

setting_save(settings);

// 读取数据
const default_data = loadJSON("./data/default_data.json");
let admin_config;
try {
  admin_config = loadJSON("./config/admin_user.json");
} catch {
  admin_config = default_data.users;
}

const admin_users = admin_config.users || {};

function authenticate(username, password) {
  if (typeof username !== "string" || typeof password !== "string") {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(admin_users, username)) {
    return false;
  }
  const user = admin_users[username];
  if (typeof user === "string") {
    return user === password;
  }
  return !!(
    user &&
    user.enabled !== false &&
    typeof user.password === "string" &&
    user.password === password
  );
}

try {
  const cppversion = parseInt(
    fs
      .readFileSync("ygopro/gframe/config.h", "utf8")
      .match(/PRO_VERSION\s?=\s?([x\dABCDEF]+)/)[1],
    16,
  );
  setting_change(settings, "version", cppversion);
  log.info(
    `ygopro version 0x${settings.version.toString(16)}`,
    "(from source code)",
  );
} catch {
  log.info(
    `ygopro version 0x${settings.version.toString(16)}`,
    "(from config)",
  );
}

// 组件
const ygopro = require("./ygopro.js");

// 获取可用内存
let memory_usage = 0;

function get_memory_usage() {
  const total_memory = os.totalmem();
  let available_memory = os.freemem();
  if (process.platform === "linux") {
    try {
      const mem_available = fs
        .readFileSync("/proc/meminfo", "utf8")
        .match(/^MemAvailable:\s+(\d+)\s+kB$/m);
      if (mem_available) {
        available_memory = parseInt(mem_available[1], 10) * 1024;
      }
    } catch { }
  }
  memory_usage = total_memory
    ? (1 - available_memory / total_memory) * 100
    : 99;
}

get_memory_usage();
setInterval(get_memory_usage, 3000);

const ROOM_all = [];
const ROOM_private_players_scores = {};

function ROOM_kick(name, callback) {
  let found = false;
  for (const room of ROOM_all) {
    if (
      !(
        room &&
        room.established &&
        (name === "all" ||
          name === room.process_pid.toString() ||
          name === room.name)
      )
    ) {
      continue;
    }
    found = true;
    if (room.duel_stage !== ygopro.constants.DUEL_STAGE.BEGIN) {
      room.scores[room.dueling_players[0].name_vpass] = 0;
      room.scores[room.dueling_players[1].name_vpass] = 0;
    }
    room.kicked = true;
    room.process.kill();
    room.delete();
  }
  callback(null, found);
}

function ROOM_player_win(name, players_scores) {
  if (!players_scores[name]) {
    players_scores[name] = {
      win: 0,
      lose: 0,
      flee: 0,
      combo: 0,
    };
  }
  players_scores[name].win++;
  players_scores[name].combo++;
}

function ROOM_player_lose(name, players_scores) {
  if (!players_scores[name]) {
    players_scores[name] = {
      win: 0,
      lose: 0,
      flee: 0,
      combo: 0,
    };
  }
  players_scores[name].lose++;
  players_scores[name].combo = 0;
}

function ROOM_player_flee(name, players_scores) {
  if (!players_scores[name]) {
    players_scores[name] = {
      win: 0,
      lose: 0,
      flee: 0,
      combo: 0,
    };
  }
  players_scores[name].flee++;
  players_scores[name].combo = 0;
}

function ROOM_player_get_score(player, players_scores) {
  const name = player.name_vpass;
  const score = players_scores[name];
  if (!score) {
    return `${player.name} \${random_score_blank}`;
  }
  const total = score.win + score.lose;
  if (score.win < 2 && total < 3) {
    return `${player.name} \${random_score_not_enough}`;
  }
  if (score.combo >= 2) {
    return `\${random_score_part1}${player.name} \${random_score_part2} ${Math.ceil((score.win / total) * 100)}\${random_score_part3} ${Math.ceil((score.flee / total) * 100)}\${random_score_part4_combo}${score.combo}\${random_score_part5_combo}`;
  } else {
    //return player.name + " 的今日战绩：胜率" + Math.ceil(score.win/total*100) + "%，逃跑率" + Math.ceil(score.flee/total*100) + "%，" + score.combo + "连胜中！"
    return `\${random_score_part1}${player.name} \${random_score_part2} ${Math.ceil((score.win / total) * 100)}\${random_score_part3} ${Math.ceil((score.flee / total) * 100)}\${random_score_part4}`;
  }
}

function ROOM_record_match_scores(score_array, players_scores) {
  if (score_array.length === 2) {
    if (score_array[0].score !== score_array[1].score) {
      if (score_array[0].score > score_array[1].score) {
        ROOM_player_win(score_array[0].name_vpass, players_scores);
        ROOM_player_lose(score_array[1].name_vpass, players_scores);
      } else {
        ROOM_player_win(score_array[1].name_vpass, players_scores);
        ROOM_player_lose(score_array[0].name_vpass, players_scores);
      }
    }
  }
  if (score_array.length === 1) {
    // same name
    ROOM_player_win(score_array[0].name_vpass, players_scores);
    ROOM_player_lose(score_array[0].name_vpass, players_scores);
  }
}

function ROOM_get_scores(players_scores, limit) {
  const scores = Object.entries(players_scores).sort((left, right) => {
    return right[1].win - left[1].win || left[1].lose - right[1].lose;
  });
  return limit == null ? scores : scores.slice(0, limit);
}

let rooms_count = 0;
if (settings.modules.max_rooms_count) {
  function get_rooms_count() {
    let active_rooms_count = 0;
    for (const room of ROOM_all) {
      if (room && room.established) {
        active_rooms_count++;
      }
    }
    rooms_count = active_rooms_count;
    setTimeout(get_rooms_count, 1000);
  }
  setTimeout(get_rooms_count, 1000);
}

function ROOM_find_or_create_by_name(name) {
  const room = ROOM_find_by_name(name);
  if (room) {
    return room;
  } else if (
    memory_usage >= 90 ||
    (settings.modules.max_rooms_count &&
      rooms_count >= settings.modules.max_rooms_count)
  ) {
    return null;
  } else {
    return new Room(name);
  }
}

function ROOM_find_by_name(name) {
  return ROOM_all.find((room) => room && room.name === name);
}

function ROOM_validate(name) {
  const [client_name, client_pass] = name.split("$", 2);
  if (!client_pass) {
    return true;
  }
  return !ROOM_all.find((room) => {
    if (!room) {
      return false;
    }
    const [room_name, room_pass] = room.name.split("$", 2);
    return client_name === room_name && client_pass !== room_pass;
  });
}

function CLIENT_kick(client) {
  if (!client) {
    return false;
  }
  client.system_kicked = true;
  client.destroy();
  return true;
}

function SERVER_kick(server) {
  if (!server) {
    return false;
  }
  server.system_kicked = true;
  server.destroy();
  return true;
}

class Room {
  constructor(name, hostinfo) {
    this.hostinfo = hostinfo;
    this.name = name;
    this.players = [];
    this.established = false;
    this.scores = {};
    this.duel_count = 0;
    this.turn = 0;
    this.duel_stage = ygopro.constants.DUEL_STAGE.BEGIN;
    ROOM_all.push(this);
    if (!this.hostinfo) {
      this.hostinfo = JSON.parse(JSON.stringify(settings.hostinfo));
    }
    delete this.hostinfo.comment;
    let param;
    if (name.startsWith("M#")) {
      this.hostinfo.mode = 1;
    } else if (name.startsWith("T#")) {
      this.hostinfo.mode = 2;
      this.hostinfo.start_lp = 16000;
    } else if (
      (param = name.match(/^(\d)(\d)(T|F)(T|F)(T|F)(\d+),(\d+),(\d+)/i))
    ) {
      this.hostinfo.rule = parseInt(param[1]);
      this.hostinfo.mode = parseInt(param[2]);
      if (param[3] === "T") {
        this.hostinfo.duel_rule = 3;
      }
      this.hostinfo.no_check_deck = param[4] === "T";
      this.hostinfo.no_shuffle_deck = param[5] === "T";
      this.hostinfo.start_lp = parseInt(param[6]);
      this.hostinfo.start_hand = parseInt(param[7]);
      this.hostinfo.draw_count = parseInt(param[8]);
    } else if ((param = name.match(/(.+)#/)) !== null) {
      const rule = param[1].toUpperCase();
      if (rule.match(/(^|，|,)(M|MATCH)(，|,|$)/)) {
        this.hostinfo.mode = 1;
      }
      if (rule.match(/(^|，|,)(T|TAG)(，|,|$)/)) {
        this.hostinfo.mode = 2;
        this.hostinfo.start_lp = 16000;
      }
      if (rule.match(/(^|，|,)(TCGONLY|TO)(，|,|$)/)) {
        this.hostinfo.rule = 1;
      }
      if (rule.match(/(^|，|,)(OCGONLY|OO)(，|,|$)/)) {
        this.hostinfo.rule = 0;
      }
      if (rule.match(/(^|，|,)(SC|CCG)(，|,|$)/)) {
        this.hostinfo.rule = 2;
        this.hostinfo.lflist = -1;
      }
      if (rule.match(/(^|，|,)(OT|TCG)(，|,|$)/)) {
        this.hostinfo.rule = 5;
      }
      if ((param = rule.match(/(^|，|,)LP(\d+)(，|,|$)/))) {
        let start_lp = parseInt(param[2]);
        if (start_lp <= 0) {
          start_lp = 1;
        }
        if (start_lp >= 99999) {
          start_lp = 99999;
        }
        this.hostinfo.start_lp = start_lp;
      }
      if ((param = rule.match(/(^|，|,)(TIME|TM|TI)(\d+)(，|,|$)/))) {
        let time_limit = parseInt(param[3]);
        if (time_limit < 0) {
          time_limit = 180;
        }
        if (time_limit >= 1 && time_limit <= 60) {
          time_limit = time_limit * 60;
        }
        if (time_limit >= 999) {
          time_limit = 999;
        }
        this.hostinfo.time_limit = time_limit;
      }
      if ((param = rule.match(/(^|，|,)(START|ST)(\d+)(，|,|$)/))) {
        let start_hand = parseInt(param[3]);
        if (start_hand <= 0) {
          start_hand = 1;
        }
        if (start_hand >= 40) {
          start_hand = 40;
        }
        this.hostinfo.start_hand = start_hand;
      }
      if ((param = rule.match(/(^|，|,)(DRAW|DR)(\d+)(，|,|$)/))) {
        let draw_count = parseInt(param[3]);
        if (draw_count >= 35) {
          draw_count = 35;
        }
        this.hostinfo.draw_count = draw_count;
      }
      if ((param = rule.match(/(^|，|,)(LFLIST|LF)(\d+)(，|,|$)/))) {
        const lflist = parseInt(param[3]) - 1;
        this.hostinfo.lflist = lflist;
      }
      if (rule.match(/(^|，|,)(NOLFLIST|NF)(，|,|$)/)) {
        this.hostinfo.lflist = -1;
      }
      if (rule.match(/(^|，|,)(NOUNIQUE|NU)(，|,|$)/)) {
        this.hostinfo.rule = 4;
      }
      if (rule.match(/(^|，|,)(NOCHECK|NC)(，|,|$)/)) {
        this.hostinfo.no_check_deck = true;
      }
      if (rule.match(/(^|，|,)(NOSHUFFLE|NS)(，|,|$)/)) {
        this.hostinfo.no_shuffle_deck = true;
      }
      if (rule.match(/(^|，|,)(IGPRIORITY|PR)(，|,|$)/)) {
        // deprecated
        this.hostinfo.duel_rule = 4;
      }
      if ((param = rule.match(/(^|，|,)(DUELRULE|MR)(\d+)(，|,|$)/))) {
        const duel_rule = parseInt(param[3]);
        if (duel_rule && duel_rule > 0 && duel_rule <= 5) {
          this.hostinfo.duel_rule = duel_rule;
        }
      }
      if (rule.match(/(^|，|,)(NOWATCH|NW)(，|,|$)/)) {
        this.hostinfo.no_watch = true;
      }
    }
    this.hostinfo.replay_mode = 0; // 0x1: Save the replays in file. 0x2: Block the replays to observers.
    param = [
      0,
      this.hostinfo.lflist,
      this.hostinfo.rule,
      this.hostinfo.mode,
      this.hostinfo.duel_rule,
      this.hostinfo.no_check_deck ? "T" : "F",
      this.hostinfo.no_shuffle_deck ? "T" : "F",
      this.hostinfo.start_lp,
      this.hostinfo.start_hand,
      this.hostinfo.draw_count,
      this.hostinfo.time_limit,
      this.hostinfo.replay_mode,
    ];
    try {
      this.process = spawn("./ygopro", param, {
        cwd: "ygopro",
      });
      this.process_pid = this.process.pid;
      this.process.on("error", (err) => {
        log.warn("CREATE ROOM ERROR", err);
        for (const player of this.players) {
          ygopro.stoc_die(player, "${create_room_failed}");
        }
        this.delete();
      });
      this.process.on("exit", (code) => {
        if (!this.disconnector) {
          this.disconnector = "server";
        }
        this.delete();
      });
      this.process.stdout.setEncoding("utf8");
      this.process.stdout.once("data", (data) => {
        this.established = true;
        this.port = parseInt(data);
        for (const player of this.players) {
          player.server.connect(this.port, "127.0.0.1", () => {
            for (const buffer of player.pre_establish_buffers) {
              player.server.write(buffer);
            }
            player.established = true;
            player.pre_establish_buffers = [];
          });
        }
      });
      this.process.stderr.on("data", (data) => {
        data = "Debug: " + data;
        data = data.replace(/\n$/, "");
        log.info("YGOPRO " + data);
        ygopro.stoc_send_chat_to_room(this, data, ygopro.constants.COLORS.RED);
        this.ygopro_error_length = this.ygopro_error_length
          ? this.ygopro_error_length + data.length
          : data.length;
        if (this.ygopro_error_length > 10000) {
          this.process.kill();
        }
      });
    } catch (error) {
      log.warn("CREATE ROOM FAIL", error);
      this.error = "${create_room_failed}";
    }
  }

  delete() {
    if (this.deleted) {
      return;
    }
    const score_array = [];
    for (const [name, score] of Object.entries(this.scores)) {
      score_array.push({
        name: name.split("$")[0],
        score: score,
        name_vpass: name,
      });
    }
    if (settings.modules.private_duel.record_match_scores && !this.kicked) {
      // Arena 不创建 Tag 房，手工 Tag 房的排行榜完整性不在本分支支持范围内。
      if (this.hostinfo.mode !== 2) {
        ROOM_record_match_scores(score_array, ROOM_private_players_scores);
      }
    }
    this.players = [];
    this.deleted = true;
    const index = ROOM_all.indexOf(this);
    if (index !== -1) {
      ROOM_all[index] = null;
    }
  }

  connect(client) {
    this.players.push(client);
    if (this.established) {
      client.server.connect(this.port, "127.0.0.1", () => {
        for (const buffer of client.pre_establish_buffers) {
          client.server.write(buffer);
        }
        client.established = true;
        client.pre_establish_buffers = [];
      });
    }
  }

  disconnect(client, error) {
    const index = this.players.indexOf(client);
    if (index !== -1) {
      this.players.splice(index, 1);
    }
    if (
      this.duel_stage !== ygopro.constants.DUEL_STAGE.BEGIN &&
      this.disconnector !== "server" &&
      client.pos < 4
    ) {
      this.finished = true;
      this.scores[client.name_vpass] = -9;
      if (settings.modules.private_duel.record_match_scores) {
        ROOM_player_flee(client.name_vpass, ROOM_private_players_scores);
      }
    }
    if (this.players.length) {
      ygopro.stoc_send_chat_to_room(
        this,
        `${client.name} \${left_game}` + (error ? `: ${error}` : ""),
      );
    } else {
      //client.room = null
      this.process.kill();
      //client.room = null
      this.delete();
    }
    SERVER_kick(client.server);
  }
}

// 网络连接
net
  .createServer((client) => {
    client.ip = client.remoteAddress;
    client.is_local = client.ip && client.ip.includes("127.0.0.1");
    // server stand for the connection to ygopro server process
    const server = new net.Socket();
    client.server = server;
    server.client = client;
    client.setTimeout(2000); //连接前超时2秒

    // 释放处理
    client.on("close", () => {
      const room = ROOM_all[client.rid];
      if (!client.room_closed) {
        client.room_closed = true;
        if (room) {
          room.disconnect(client);
        } else {
          SERVER_kick(client.server);
        }
      }
    });
    client.on("error", (error) => {
      const room = ROOM_all[client.rid];
      if (!client.room_closed) {
        client.room_closed = true;
        if (room) {
          room.disconnect(client, error);
        } else {
          SERVER_kick(client.server);
        }
      }
    });
    client.on("timeout", () => {
      client.destroy();
    });
    server.on("close", () => {
      if (!server.room_closed) {
        server.room_closed = true;
      }
      if (!server.client) {
        return;
      }
      const room = ROOM_all[server.client.rid];
      if (room && !server.system_kicked) {
        room.disconnector = "server";
      }
      if (!server.client.room_closed) {
        ygopro.stoc_send_chat(
          server.client,
          "${server_closed}",
          ygopro.constants.COLORS.RED,
        );
        CLIENT_kick(server.client);
      }
    });
    server.on("error", (error) => {
      server.room_closed = error;
      if (!server.client) {
        return;
      }
      const room = ROOM_all[server.client.rid];
      if (room && !server.system_kicked) {
        room.disconnector = "server";
      }
      if (!server.client.room_closed) {
        ygopro.stoc_send_chat(
          server.client,
          `\${server_error}: ${error}`,
          ygopro.constants.COLORS.RED,
        );
        CLIENT_kick(server.client);
      }
    });
    if (typeof client.ip === "undefined") {
      log.info("CLIENT IP undefined");
      CLIENT_kick(client);
      return;
    }
    // 客户端到服务端(ctos)协议分析
    client.pre_establish_buffers = [];
    client.on("data", (ctos_buffer) => {
      if (client.server) {
        let ctos_message_length = 0;
        let ctos_proto = 0;
        const datas = [];
        let looplimit = 0;
        while (true) {
          if (ctos_message_length === 0) {
            if (ctos_buffer.length >= 2) {
              ctos_message_length = ctos_buffer.readUInt16LE(0);
            } else {
              if (ctos_buffer.length !== 0) {
                log.warn("bad ctos_buffer length", client.ip);
              }
              break;
            }
          } else if (ctos_proto === 0) {
            if (ctos_buffer.length >= 3) {
              ctos_proto = ctos_buffer.readUInt8(2);
            } else {
              log.warn("bad ctos_proto length", client.ip);
              break;
            }
          } else {
            if (ctos_buffer.length >= 2 + ctos_message_length) {
              let cancel = false;
              const b = ctos_buffer.slice(3, ctos_message_length - 1 + 3);
              let info = null;
              const struct =
                ygopro.structs[ygopro.proto_structs.CTOS[ygopro.constants.CTOS[ctos_proto]]];
              if (struct) {
                struct._setBuff(b);
                info = { ...struct.fields };
              }
              if (ygopro.ctos_follows[ctos_proto]) {
                const result = ygopro.ctos_follows[ctos_proto].callback(
                  b,
                  info,
                  client,
                  client.server,
                  datas,
                );
                if (result && ygopro.ctos_follows[ctos_proto].synchronous) {
                  cancel = true;
                }
              }
              if (!cancel) {
                datas.push(ctos_buffer.slice(0, 2 + ctos_message_length));
              }
              ctos_buffer = ctos_buffer.slice(2 + ctos_message_length);
              ctos_message_length = 0;
              ctos_proto = 0;
            } else {
              if (ctos_message_length !== 17735) {
                log.warn(
                  "bad ctos_message length",
                  client.ip,
                  ctos_buffer.length,
                  ctos_message_length,
                  ctos_proto,
                );
              }
              break;
            }
          }
          looplimit++;
          if (looplimit > 800) {
            log.info("error ctos", client.name, client.ip);
            CLIENT_kick(client);
            break;
          }
        }
        if (client.established) {
          for (const buffer of datas) {
            client.server.write(buffer);
          }
        } else {
          for (const buffer of datas) {
            client.pre_establish_buffers.push(buffer);
          }
        }
      }
    });
    // 服务端到客户端(stoc)
    server.on("data", (stoc_buffer) => {
      let stoc_message_length = 0;
      let stoc_proto = 0;
      const datas = [];
      let looplimit = 0;
      while (true) {
        if (stoc_message_length === 0) {
          if (stoc_buffer.length >= 2) {
            stoc_message_length = stoc_buffer.readUInt16LE(0);
          } else {
            if (stoc_buffer.length !== 0) {
              log.warn("bad stoc_buffer length", server.client.ip);
            }
            break;
          }
        } else if (stoc_proto === 0) {
          if (stoc_buffer.length >= 3) {
            stoc_proto = stoc_buffer.readUInt8(2);
          } else {
            log.warn("bad stoc_proto length", server.client.ip);
            break;
          }
        } else {
          if (stoc_buffer.length >= 2 + stoc_message_length) {
            let cancel = false;
            const b = stoc_buffer.slice(3, stoc_message_length - 1 + 3);
            let info = null;
            const struct =
              ygopro.structs[ygopro.proto_structs.STOC[ygopro.constants.STOC[stoc_proto]]];
            if (struct) {
              struct._setBuff(b);
              info = { ...struct.fields };
            }
            if (ygopro.stoc_follows[stoc_proto]) {
              const result = ygopro.stoc_follows[stoc_proto].callback(
                b,
                info,
                server.client,
                server,
                datas,
              );
              if (result && ygopro.stoc_follows[stoc_proto].synchronous) {
                cancel = true;
              }
            }
            if (!cancel) {
              datas.push(stoc_buffer.slice(0, 2 + stoc_message_length));
            }
            stoc_buffer = stoc_buffer.slice(2 + stoc_message_length);
            stoc_message_length = 0;
            stoc_proto = 0;
          } else {
            log.warn("bad stoc_message length", server.client.ip);
            break;
          }
        }
        looplimit++;
        if (looplimit > 800) {
          log.info("error stoc", server.client.name);
          server.destroy();
          break;
        }
      }
      if (server.client && !server.client.room_closed) {
        for (const buffer of datas) {
          server.client.write(buffer);
        }
      }
    });
  })
  .listen(settings.port, () => {
    log.info("server started", settings.port);
  });

if (settings.modules.stop) {
  log.info("NOTE: server not open due to config, ", settings.modules.stop);
}

// 功能模块
// return true to cancel a synchronous message
ygopro.ctos_follow("PLAYER_INFO", true, (buffer, info, client) => {
  // checkmate use username$password, but here don't
  // so remove the password
  const name_full = info.name.split("$");
  const name = name_full[0];
  let vpass = name_full[1];
  if (vpass && !vpass.length) {
    vpass = null;
  }
  const struct = ygopro.structs.CTOS_PlayerInfo;
  struct._setBuff(buffer);
  struct.set("name", name);
  client.name = name;
  client.vpass = vpass;
  client.name_vpass = vpass ? `${name}$${vpass}` : name;
  client.lang = "zh-cn";
  return false;
});

ygopro.ctos_follow("JOIN_GAME", false, (buffer, info, client) => {
  info.pass = info.pass.trim();
  client.pass = info.pass;
  if (settings.modules.stop) {
    ygopro.stoc_die(client, settings.modules.stop);
  } else if (info.version !== settings.version) {
    ygopro.stoc_send_chat(
      client,
      info.version < settings.version
        ? settings.modules.update
        : settings.modules.wait_update,
      ygopro.constants.COLORS.RED,
    );
    ygopro.stoc_send(client, "ERROR_MSG", {
      msg: 4,
      code: settings.version,
    });
    CLIENT_kick(client);
  } else if (!info.pass.length) {
    ygopro.stoc_die(client, "${blank_room_name}");
  } else if (!client.name || client.name === "") {
    ygopro.stoc_die(client, "${bad_user_name}");
  } else if (info.pass.length && !ROOM_validate(info.pass)) {
    ygopro.stoc_die(client, "${invalid_password_room}");
  } else {
    const room = ROOM_find_or_create_by_name(info.pass);
    if (!room) {
      ygopro.stoc_die(client, settings.modules.full);
    } else if (room.error) {
      ygopro.stoc_die(client, room.error);
    } else if (room.duel_stage !== ygopro.constants.DUEL_STAGE.BEGIN) {
      ygopro.stoc_die(client, "${watch_denied}");
    } else if (
      room.hostinfo.no_watch &&
      room.players.length >= (room.hostinfo.mode === 2 ? 4 : 2)
    ) {
      ygopro.stoc_die(client, "${watch_denied_room}");
    } else {
      client.setTimeout(300000); //连接后超时5分钟
      client.rid = ROOM_all.indexOf(room);
      room.connect(client);
    }
  }
});

ygopro.stoc_follow("JOIN_GAME", false, (buffer, info, client) => {
  //欢迎信息
  const room = ROOM_all[client.rid];
  if (!room) {
    return;
  }
  if (settings.modules.welcome) {
    ygopro.stoc_send_chat(
      client,
      settings.modules.welcome,
      ygopro.constants.COLORS.GREEN,
    );
  }
  if (settings.modules.private_duel.record_match_scores) {
    ygopro.stoc_send_chat_to_room(
      room,
      ROOM_player_get_score(client, ROOM_private_players_scores),
      ygopro.constants.COLORS.GREEN,
    );
    for (const player of room.players) {
      if (player.pos !== 7 && player !== client) {
        ygopro.stoc_send_chat(
          client,
          ROOM_player_get_score(player, ROOM_private_players_scores),
          ygopro.constants.COLORS.GREEN,
        );
      }
    }
  }
});

ygopro.stoc_follow("GAME_MSG", true, (buffer, info, client) => {
  const room = ROOM_all[client.rid];
  if (!room) {
    return;
  }
  const msg = buffer.readInt8(0);
  const msg_name = ygopro.constants.MSG[msg];
  if (msg_name === "START") {
    const playertype = buffer.readUInt8(1);
    client.is_first = !(playertype & 0xf);
    client.lp = room.hostinfo.start_lp;
    room.duel_stage = ygopro.constants.DUEL_STAGE.DUELING;
    if (client.pos === 0) {
      room.turn = 0;
      room.duel_count++;
    }
  }
  if (msg_name === "NEW_TURN") {
    if (client.pos === 0) {
      room.turn++;
    }
  }
  if (msg_name === "WIN" && client.pos === 0) {
    let pos = buffer.readUInt8(1);
    if (
      !(
        client.is_first ||
        pos === 2 ||
        room.duel_stage !== ygopro.constants.DUEL_STAGE.DUELING
      )
    ) {
      pos = 1 - pos;
    }
    if (pos >= 0 && room.hostinfo.mode === 2) {
      pos = pos * 2;
    }
    room.winner = pos;
    room.turn = 0;
    room.duel_stage = ygopro.constants.DUEL_STAGE.END;
    if (room && !room.finished && room.dueling_players[pos]) {
      room.winner_name = room.dueling_players[pos].name_vpass;
      room.scores[room.winner_name] = room.scores[room.winner_name] + 1;
      if (room.match_kill) {
        room.match_kill = false;
        room.scores[room.winner_name] = 99;
      }
    }
  }
  if (msg_name === "MATCH_KILL" && client.pos === 0) {
    room.match_kill = true;
  }
  //lp跟踪
  if (msg_name === "DAMAGE" && client.pos === 0) {
    let pos = buffer.readUInt8(1);
    if (!client.is_first) {
      pos = 1 - pos;
    }
    if (pos >= 0 && room.hostinfo.mode === 2) {
      pos = pos * 2;
    }
    const val = buffer.readInt32LE(2);
    room.dueling_players[pos].lp -= val;
    if (room.dueling_players[pos].lp < 0) {
      room.dueling_players[pos].lp = 0;
    }
    if (
      room.dueling_players[pos].lp > 0 &&
      room.dueling_players[pos].lp <= 100
    ) {
      ygopro.stoc_send_chat_to_room(
        room,
        "${lp_low_opponent}",
        ygopro.constants.COLORS.PINK,
      );
    }
  }
  if (msg_name === "RECOVER" && client.pos === 0) {
    let pos = buffer.readUInt8(1);
    if (!client.is_first) {
      pos = 1 - pos;
    }
    if (pos >= 0 && room.hostinfo.mode === 2) {
      pos = pos * 2;
    }
    const val = buffer.readInt32LE(2);
    room.dueling_players[pos].lp += val;
  }
  if (msg_name === "LPUPDATE" && client.pos === 0) {
    let pos = buffer.readUInt8(1);
    if (!client.is_first) {
      pos = 1 - pos;
    }
    if (pos >= 0 && room.hostinfo.mode === 2) {
      pos = pos * 2;
    }
    const val = buffer.readInt32LE(2);
    room.dueling_players[pos].lp = val;
  }
  if (msg_name === "PAY_LPCOST" && client.pos === 0) {
    let pos = buffer.readUInt8(1);
    if (!client.is_first) {
      pos = 1 - pos;
    }
    if (pos >= 0 && room.hostinfo.mode === 2) {
      pos = pos * 2;
    }
    const val = buffer.readInt32LE(2);
    room.dueling_players[pos].lp -= val;
    if (room.dueling_players[pos].lp < 0) {
      room.dueling_players[pos].lp = 0;
    }
    if (
      room.dueling_players[pos].lp > 0 &&
      room.dueling_players[pos].lp <= 100
    ) {
      ygopro.stoc_send_chat_to_room(
        room,
        "${lp_low_self}",
        ygopro.constants.COLORS.PINK,
      );
    }
  }
  return false;
});

//房间管理
ygopro.ctos_follow("HS_TOOBSERVER", true, (buffer, info, client) => {
  const room = ROOM_all[client.rid];
  if (!room) {
    return;
  }
  if (room.hostinfo.no_watch) {
    ygopro.stoc_send_chat(
      client,
      "${watch_denied_room}",
      ygopro.constants.COLORS.RED,
    );
    return true;
  }
  return false;
});

ygopro.ctos_follow("HS_KICK", true, (buffer, info, client) => {
  const room = ROOM_all[client.rid];
  if (!room) {
    return;
  }
  for (const player of room.players) {
    if (player && player.pos === info.pos && player !== client) {
      ygopro.stoc_send_chat_to_room(
        room,
        `${player.name} \${kicked_by_player}`,
        ygopro.constants.COLORS.RED,
      );
      if (
        client.is_host &&
        room.duel_stage === ygopro.constants.DUEL_STAGE.BEGIN &&
        player.server
      ) {
        // YGOPro closes the target socket after handling HS_KICK; this is not a room server failure.
        player.server.system_kicked = true;
      }
    }
  }
  return false;
});

ygopro.stoc_follow("TYPE_CHANGE", true, (buffer, info, client) => {
  const selftype = info.type & 0xf;
  const is_host = ((info.type >> 4) & 0xf) !== 0;
  client.is_host = is_host;
  client.pos = selftype;
  return false;
});

ygopro.stoc_follow("DUEL_START", false, (buffer, info, client) => {
  const room = ROOM_all[client.rid];
  if (!room) {
    return;
  }
  if (room.duel_stage === ygopro.constants.DUEL_STAGE.BEGIN) {
    //first start
    room.duel_stage = ygopro.constants.DUEL_STAGE.FINGER;
    room.turn = 0;
    room.dueling_players = [];
    for (const player of room.players) {
      if (!(player.pos !== 7)) {
        continue;
      }
      room.dueling_players[player.pos] = player;
      room.scores[player.name_vpass] = 0;
    }
  } else if (
    room.duel_stage === ygopro.constants.DUEL_STAGE.SIDING &&
    client.pos < 4
  ) {
    // side deck verified
    if (client.side_tcount) {
      clearInterval(client.side_interval);
      client.side_interval = null;
      client.side_tcount = null;
    }
  }
});

ygopro.ctos_follow("SURRENDER", true, (buffer, info, client) => {
  const room = ROOM_all[client.rid];
  if (!room) {
    return;
  }
  if (room.duel_stage === ygopro.constants.DUEL_STAGE.BEGIN) {
    return true;
  }
  return false;
});

ygopro.ctos_follow("UPDATE_DECK", true, (buffer, info, client) => {
  const room = ROOM_all[client.rid];
  if (!room) {
    return false;
  }
  if (info.mainc > 256 || info.sidec > 256) {
    // Prevent attack, see https://github.com/Fluorohydride/ygopro/issues/2174
    CLIENT_kick(client);
    return true;
  }
  return false;
});

ygopro.stoc_follow("SELECT_HAND", false, (buffer, info, client) => {
  const room = ROOM_all[client.rid];
  if (!room) {
    return;
  }
  if (client.pos === 0) {
    room.duel_stage = ygopro.constants.DUEL_STAGE.FINGER;
  }
});

ygopro.stoc_follow("SELECT_TP", false, (buffer, info, client) => {
  const room = ROOM_all[client.rid];
  if (!room) {
    return;
  }
  room.duel_stage = ygopro.constants.DUEL_STAGE.FIRSTGO;
});

ygopro.stoc_follow("CHANGE_SIDE", false, (buffer, info, client) => {
  const room = ROOM_all[client.rid];
  if (!room) {
    return;
  }
  if (client.pos === 0) {
    room.duel_stage = ygopro.constants.DUEL_STAGE.SIDING;
  }
});

// HTTP 管理接口
if (settings.modules.http) {
  function addCallback(callback, text) {
    if (!callback) {
      return text;
    }
    return `${callback}( ${text} );`;
  }

  function requestListener(request, response) {
    const u = url.parse(request.url, true);
    if (u.pathname === "/api/getrooms") {
      const pass_validated = authenticate(u.query.username, u.query.pass);
      if (!settings.modules.http.public_roomlist && !pass_validated) {
        response.writeHead(200);
        response.end(
          addCallback(
            u.query.callback,
            '{"rooms":[{"roomid":"0","roomname":"密码错误","needpass":"true"}]}',
          ),
        );
      } else {
        const roomsjson = [];
        for (const room of ROOM_all) {
          if (room && room.established) {
            roomsjson.push({
              roomid: room.process_pid.toString(),
              roomname: pass_validated ? room.name : room.name.split("$", 2)[0],
              roommode: room.hostinfo.mode,
              needpass: (room.name.indexOf("$") !== -1).toString(),
              users: room.players
                .filter((player) => player.pos != null)
                .map((player) => ({
                  id: (-1).toString(),
                  name: player.name,
                  ip:
                    settings.modules.http.show_ip &&
                      pass_validated &&
                      !player.is_local
                      ? player.ip.slice(7)
                      : null,
                  status:
                    settings.modules.http.show_info &&
                      room.duel_stage !== ygopro.constants.DUEL_STAGE.BEGIN &&
                      player.pos !== 7
                      ? {
                        score: room.scores[player.name_vpass],
                        lp:
                          player.lp != null
                            ? player.lp
                            : room.hostinfo.start_lp,
                      }
                      : null,
                  pos: player.pos,
                }))
                .sort((left, right) => left.pos - right.pos),
              istart:
                room.duel_stage !== ygopro.constants.DUEL_STAGE.BEGIN
                  ? settings.modules.http.show_info
                    ? "Duel:" +
                    room.duel_count +
                    " " +
                    (room.duel_stage === ygopro.constants.DUEL_STAGE.SIDING
                      ? "Siding"
                      : "Turn:" + (room.turn != null ? room.turn : 0))
                    : "start"
                  : "wait",
            });
          }
        }
        response.writeHead(200);
        response.end(
          addCallback(
            u.query.callback,
            JSON.stringify({
              rooms: roomsjson,
            }),
          ),
        );
      }
    } else if (u.pathname === "/api/getscores") {
      if (
        u.query.limit != null &&
        (typeof u.query.limit !== "string" || !/^\d+$/.test(u.query.limit))
      ) {
        response.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            error: "limit must be a non-negative integer",
          }),
        );
        return;
      }
      const score_type = u.query.type || "private";
      if (score_type !== "private") {
        response.writeHead(400, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            error: "type must be private",
          }),
        );
        return;
      }
      if (!authenticate(u.query.username, u.query.pass)) {
        response.writeHead(403, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            error: "unauthorized",
          }),
        );
        return;
      }
      const limit = u.query.limit != null ? parseInt(u.query.limit, 10) : null;
      const scores = ROOM_get_scores(ROOM_private_players_scores, limit).map(
        (score_pair) => {
          const score = score_pair[1];
          const total = score.win + score.lose;
          return {
            name: score_pair[0].split("$", 2)[0],
            win: score.win,
            lose: score.lose,
            flee: score.flee,
            combo: score.combo,
            total: total,
            winRate: total ? Math.ceil((score.win / total) * 100) : 0,
            fleeRate: total ? Math.ceil((score.flee / total) * 100) : 0,
          };
        },
      );
      const content_type = u.query.callback
        ? "application/javascript; charset=utf-8"
        : "application/json; charset=utf-8";
      response.writeHead(200, {
        "Content-Type": content_type,
      });
      response.end(
        addCallback(
          u.query.callback,
          JSON.stringify({
            type: score_type,
            scores: scores,
          }),
        ),
      );
    } else if (u.pathname === "/api/message") {
      if (u.query.shout) {
        if (!authenticate(u.query.username, u.query.pass)) {
          response.writeHead(200);
          response.end(addCallback(u.query.callback, "['密码错误', 0]"));
          return;
        }
        for (const room of ROOM_all) {
          if (room && room.established) {
            ygopro.stoc_send_chat_to_room(
              room,
              u.query.shout,
              ygopro.constants.COLORS.YELLOW,
            );
          }
        }
        response.writeHead(200);
        response.end(
          addCallback(
            u.query.callback,
            "['shout ok', '" + u.query.shout + "']",
          ),
        );
      } else if (u.query.stop) {
        if (!authenticate(u.query.username, u.query.pass)) {
          response.writeHead(200);
          response.end(addCallback(u.query.callback, "['密码错误', 0]"));
          return;
        }
        if (u.query.stop === "false") {
          u.query.stop = false;
        }
        response.writeHead(200);
        try {
          setting_change(settings, "modules:stop", u.query.stop);
          response.end(
            addCallback(
              u.query.callback,
              "['stop ok', '" + u.query.stop + "']",
            ),
          );
        } catch {
          response.end(
            addCallback(
              u.query.callback,
              "['stop fail', '" + u.query.stop + "']",
            ),
          );
        }
      } else if (u.query.kick) {
        if (!authenticate(u.query.username, u.query.pass)) {
          response.writeHead(200);
          response.end(addCallback(u.query.callback, "['密码错误', 0]"));
          return;
        }
        ROOM_kick(u.query.kick, (err, found) => {
          response.writeHead(200);
          if (err) {
            return response.end(
              addCallback(
                u.query.callback,
                "['kick fail', '" + u.query.kick + "']",
              ),
            );
          } else if (found) {
            return response.end(
              addCallback(
                u.query.callback,
                "['kick ok', '" + u.query.kick + "']",
              ),
            );
          } else {
            return response.end(
              addCallback(
                u.query.callback,
                "['room not found', '" + u.query.kick + "']",
              ),
            );
          }
        });
      } else if (u.query.reboot) {
        if (!authenticate(u.query.username, u.query.pass)) {
          response.writeHead(200);
          response.end(addCallback(u.query.callback, "['密码错误', 0]"));
          return;
        }
        ROOM_kick("all", () => {
          response.writeHead(200);
          response.end(
            addCallback(
              u.query.callback,
              "['reboot ok', '" + u.query.reboot + "']",
            ),
          );
          return process.exit();
        });
      } else {
        response.writeHead(400);
        response.end();
      }
    } else {
      response.writeHead(400);
      response.end();
    }
  }
  const http_server = http.createServer(requestListener);
  http_server.listen(settings.modules.http.port);
  if (settings.modules.http.ssl.enabled) {
    const https = require("https");
    const options = {
      cert: fs.readFileSync(settings.modules.http.ssl.cert),
      key: fs.readFileSync(settings.modules.http.ssl.key),
    };
    const https_server = https.createServer(options, requestListener);
    https_server.listen(settings.modules.http.ssl.port);
  }
}
