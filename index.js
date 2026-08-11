"use strict";

const net = require("net");
const http = require("http");
const url = require("url");
const fs = require("fs");
const os = require("os");
const { randomUUID } = require("crypto");
const { spawn } = require("child_process");

const merge = require("deepmerge");

const logger = require("./logger.js");
const { RoomRegistry } = require("./room-registry.js");
const { RoomObserverStream } = require("./room-observer-stream.js");
const { roomNameToHostInfo } = require("./utility.js");
const log = logger.createLogger({ name: "SRVPro" });
const SERVER_INSTANCE_ID = randomUUID();
const OBSERVER_MODE_INCLUDE_CHAT = 0x4;
const ROOM_CLOSE_DRAIN_TIMEOUT_MS = 1000;

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

const ROOM_all = new RoomRegistry();
const ROOM_players_scores = {};
const SOCKET_sessions = new WeakMap();

function ROOM_kick(name, callback) {
  let found = false;
  for (const room of ROOM_all.values()) {
    if (
      !(
        (name === "all" ||
          (room.process_pid != null && name === room.process_pid.toString()) ||
          name === room.name)
      )
    ) {
      continue;
    }
    found = true;
    room.close("admin-kick");
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

function ROOM_find_or_create_by_name(name) {
  const room = ROOM_find_by_name(name);
  if (room) {
    return room;
  } else if (
    memory_usage >= 90 ||
    (settings.modules.max_rooms_count &&
      ROOM_all.size >= settings.modules.max_rooms_count)
  ) {
    return null;
  } else {
    return new Room(name);
  }
}

function ROOM_find_by_name(name) {
  return ROOM_all.getByName(name);
}

function ROOM_validate(name) {
  const [client_name, client_pass] = name.split("$", 2);
  if (!client_pass) {
    return true;
  }
  for (const room of ROOM_all.values()) {
    const [room_name, room_pass] = room.name.split("$", 2);
    if (client_name === room_name && client_pass !== room_pass) {
      return false;
    }
  }
  return true;
}

function getSession(socket) {
  return SOCKET_sessions.get(socket);
}

function getClientRoom(client) {
  const session = getSession(client);
  return session ? session.room : undefined;
}

function writeForwarding(socket, forwarding) {
  if (Buffer.isBuffer(forwarding)) {
    socket.write(forwarding);
  } else if (forwarding) {
    for (const buffer of forwarding) {
      socket.write(buffer);
    }
  }
}

function CLIENT_kick(client) {
  if (!client) {
    return false;
  }
  const session = getSession(client);
  if (session) {
    session.kickClient();
  } else {
    client.destroy();
  }
  return true;
}

function SERVER_kick(server) {
  if (!server) {
    return false;
  }
  const session = getSession(server);
  if (session) {
    session.kickServer();
  } else {
    server.destroy();
  }
  return true;
}

class Room {
  constructor(name, hostinfo) {
    this.hostinfo = roomNameToHostInfo(
      name,
      hostinfo || JSON.parse(JSON.stringify(settings.hostinfo)),
    );
    this.name = name;
    this.players = [];
    this.established = false;
    this.scores = {};
    this.duel_count = 0;
    this.turn = 0;
    this.lifecycle = "starting";
    this.duel_stage = ygopro.constants.DUEL_STAGE.BEGIN;
    this.observerStream =
      settings.modules.enable_halfway_watch && !this.hostinfo.no_watch
        ? new RoomObserverStream(settings.version, {
            onError: (error) =>
              log.warn("ROOM OBSERVER ERROR", this.name, error),
            onReady: () => this.releaseObserverGate(),
            onEnd: () => this.observerStreamEnded(),
          })
        : null;
    if (this.observerStream) {
      this.hostinfo.replay_mode |= OBSERVER_MODE_INCLUDE_CHAT;
    }
    const param = [
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
    ROOM_all.add(this);
    try {
      this.process = spawn("./ygopro", param, {
        cwd: "ygopro",
        windowsHide: true,
      });
      this.process_pid = this.process.pid;
      this.process.on("error", (err) => {
        log.warn("CREATE ROOM ERROR", err);
        for (const player of this.players) {
          ygopro.stoc_die(player, "${create_room_failed}");
        }
        this.close("spawn-error", err);
      });
      this.process.on("exit", (code, signal) => {
        this.close("server-exit", { code, signal });
      });
      this.process.stdout.setEncoding("utf8");
      this.process.stdout.once("data", (data) => {
        if (this.lifecycle !== "starting") {
          return;
        }
        const port = parseInt(data, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          for (const player of this.players) {
            ygopro.stoc_die(player, "${create_room_failed}");
          }
          this.close("spawn-error", new Error(`invalid room port: ${data}`));
          return;
        }
        this.established = true;
        this.lifecycle = "waiting";
        this.port = port;
        for (const player of this.players) {
          const session = getSession(player);
          if (session && session.room === this) {
            session.connect(this.port);
          }
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
          this.close(
            "server-error",
            new Error("room process produced too much error output"),
          );
        }
      });
    } catch (error) {
      log.warn("CREATE ROOM FAIL", error);
      this.error = "${create_room_failed}";
      this.close("spawn-error", error);
    }
  }

  close(reason, error) {
    if (this.lifecycle === "closing" || this.lifecycle === "closed") {
      return false;
    }
    this.lifecycle = "closing";
    this.close_reason = reason;
    this.close_error = error;
    this.closeDrainSessions = new Set();
    if (reason === "server-exit") {
      this.disconnector = "server";
      for (const player of this.players) {
        const session = getSession(player);
        if (
          session &&
          !session.serverClosed &&
          session.beginRoomDrain(this)
        ) {
          this.closeDrainSessions.add(session);
        }
      }
    }
    this.closeDrainObserver =
      this.observerStream?.hasPendingDrain() || false;
    ROOM_all.beginClosing(this);
    if (
      this.closeDrainObserver &&
      reason !== "empty" &&
      reason !== "server-exit"
    ) {
      this.stopProcess();
    }
    if (this.closeDrainSessions.size || this.closeDrainObserver) {
      this.closeDrainTimer = setTimeout(() => {
        log.warn(
          "ROOM CLOSE DRAIN TIMEOUT",
          this.name,
          `sessions=${this.closeDrainSessions.size}`,
          `observer=${this.closeDrainObserver}`,
        );
        this.finalizeClose();
      }, ROOM_CLOSE_DRAIN_TIMEOUT_MS);
      return true;
    }
    this.finalizeClose();
    return true;
  }

  serverSessionClosed(session) {
    if (
      !this.closeDrainSessions ||
      !this.closeDrainSessions.delete(session)
    ) {
      return;
    }
    this.finalizeCloseIfDrained();
  }

  observerStreamEnded() {
    this.releaseObserverGate();
    if (!this.closeDrainObserver) {
      return;
    }
    this.closeDrainObserver = false;
    this.finalizeCloseIfDrained();
  }

  releaseObserverGate() {
    for (const player of this.players) {
      getSession(player)?.releaseObserverGate(this);
    }
  }

  finalizeCloseIfDrained() {
    if (
      this.lifecycle !== "closing" ||
      this.closeDrainSessions?.size ||
      this.closeDrainObserver
    ) {
      return false;
    }
    return this.finalizeClose();
  }

  finalizeClose() {
    if (this.lifecycle !== "closing") {
      return false;
    }
    if (this.closeDrainTimer) {
      clearTimeout(this.closeDrainTimer);
      this.closeDrainTimer = null;
    }
    const drainingSessions = this.closeDrainSessions;
    this.closeDrainSessions = null;
    this.closeDrainObserver = false;
    const score_array = [];
    for (const [name, score] of Object.entries(this.scores)) {
      score_array.push({
        name: name.split("$")[0],
        score: score,
        name_vpass: name,
      });
    }
    if (
      settings.modules.record_match_scores &&
      this.close_reason !== "admin-kick"
    ) {
      // Arena 不创建 Tag 房，手工 Tag 房的排行榜完整性不在本分支支持范围内。
      if (this.hostinfo.mode !== 2) {
        ROOM_record_match_scores(score_array, ROOM_players_scores);
      }
    }
    const watchers = this.observerStream ? this.observerStream.close() : [];
    ROOM_all.finishClosing(this);
    const players = this.players;
    this.players = [];
    this.dueling_players = [];
    const sessions = drainingSessions || new Set();
    for (const player of players) {
      const session = getSession(player);
      if (session) {
        sessions.add(session);
      } else {
        player.destroy();
      }
    }
    for (const session of sessions) {
      session.detach(this);
      session.close();
    }
    for (const watcher of watchers) {
      const session = getSession(watcher);
      if (session) {
        session.detach(this);
        session.close();
      } else {
        watcher.destroy();
      }
    }
    this.stopProcess();
    this.lifecycle = "closed";
    return true;
  }

  stopProcess() {
    if (
      !this.process ||
      this.process.exitCode != null ||
      this.process.killed
    ) {
      return false;
    }
    try {
      this.process.kill();
      return true;
    } catch (killError) {
      log.warn("CLOSE ROOM PROCESS ERROR", this.name, killError);
      return false;
    }
  }

  connect(client) {
    if (this.lifecycle === "closing" || this.lifecycle === "closed") {
      return false;
    }
    const session = getSession(client);
    if (!session || !session.attach(this)) {
      return false;
    }
    this.players.push(client);
    if (this.established) {
      session.connect(this.port);
    }
    return true;
  }

  connectWatcher(client) {
    if (
      !this.observerStream ||
      this.lifecycle === "closing" ||
      this.lifecycle === "closed"
    ) {
      return false;
    }
    const session = getSession(client);
    if (!session || !session.attach(this, true)) {
      return false;
    }
    if (!this.observerStream.addWatcher(client)) {
      session.detach(this);
      return false;
    }
    return true;
  }

  disconnect(client, error) {
    const session = getSession(client);
    if (session && session.postWatcher) {
      this.observerStream?.removeWatcher(client);
      session.detach(this);
      ygopro.stoc_send_chat_to_room(
        this,
        `${client.name} \${quit_watch}` + (error ? `: ${error}` : ""),
      );
      SERVER_kick(session.server);
      return;
    }
    const drainingServer = this.closeDrainSessions?.has(session);
    if (session && !drainingServer) {
      session.detach(this);
    }
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
      if (settings.modules.record_match_scores) {
        ROOM_player_flee(client.name_vpass, ROOM_players_scores);
      }
    }
    if (this.players.length) {
      ygopro.stoc_send_chat_to_room(
        this,
        `${client.name} \${left_game}` + (error ? `: ${error}` : ""),
      );
    } else {
      this.close("empty");
    }
    if (session) {
      SERVER_kick(session.server);
    }
  }
}

class PlayerSession {
  constructor(client) {
    this.client = client;
    this.server = new net.Socket();
    this.roomId = null;
    this.drainingRoom = null;
    this.clientClosed = false;
    this.serverClosed = false;
    this.serverSystemKicked = false;
    this.terminated = false;
    this.established = false;
    this.postWatcher = false;
    this.preEstablishBuffers = [];
    this.observerGateBuffers = [];
    this.ctosBuffer = Buffer.alloc(0);
    this.stocBuffer = Buffer.alloc(0);
    this.processCtosHook = this.processCtosHook.bind(this);
    this.processStocHook = this.processStocHook.bind(this);
    SOCKET_sessions.set(this.client, this);
    SOCKET_sessions.set(this.server, this);
  }

  get room() {
    if (this.drainingRoom) {
      return this.drainingRoom;
    }
    return this.roomId == null ? undefined : ROOM_all.getById(this.roomId);
  }

  attach(room, postWatcher = false) {
    if (!this.canAttach()) {
      return false;
    }
    this.roomId = room.id;
    this.postWatcher = postWatcher;
    return true;
  }

  canAttach() {
    return !(
      this.terminated ||
      this.roomId != null ||
      this.drainingRoom ||
      this.clientClosed ||
      this.serverClosed ||
      this.client.destroyed ||
      this.server.destroyed
    );
  }

  detach(room) {
    if (this.drainingRoom === room) {
      this.drainingRoom = null;
    }
    if (this.roomId === room.id) {
      this.roomId = null;
      this.postWatcher = false;
    }
  }

  beginRoomDrain(room) {
    if (this.roomId !== room.id || this.terminated) {
      return false;
    }
    // The room leaves the active registry before already-queued STOC packets finish draining.
    this.drainingRoom = room;
    return true;
  }

  start() {
    this.client.ip = this.client.remoteAddress;
    this.client.is_local =
      this.client.ip && this.client.ip.includes("127.0.0.1");
    this.client.setTimeout(2000);
    this.client.on("close", () => this.handleClientClosed());
    this.client.on("error", (error) => this.handleClientClosed(error));
    this.client.on("timeout", () => this.kickClient());
    this.client.on("data", (data) => this.handleClientData(data));
    this.server.on("close", () => this.handleServerClosed());
    this.server.on("error", (error) => this.handleServerClosed(error));
    this.server.on("data", (data) => this.handleServerData(data));

    if (typeof this.client.ip === "undefined") {
      log.info("CLIENT IP undefined");
      this.kickClient();
    }
  }

  connect(port) {
    this.server.connect(port, "127.0.0.1", () => {
      if (!this.room) {
        this.close();
        return;
      }
      writeForwarding(this.server, this.preEstablishBuffers);
      this.established = true;
      this.preEstablishBuffers = [];
    });
  }

  handleClientClosed(error) {
    if (this.clientClosed) {
      return;
    }
    this.clientClosed = true;
    this.ctosBuffer = Buffer.alloc(0);
    this.preEstablishBuffers = [];
    this.observerGateBuffers = [];
    const room = this.room;
    if (room) {
      room.disconnect(this.client, error);
    } else {
      this.kickServer();
    }
    if (this.serverClosed) {
      this.release();
    }
  }

  handleServerClosed(error) {
    if (this.serverClosed) {
      return;
    }
    this.serverClosed = true;
    this.stocBuffer = Buffer.alloc(0);
    const room = this.room;
    if (room && !this.serverSystemKicked) {
      room.disconnector = "server";
    }
    if (!this.clientClosed) {
      ygopro.stoc_send_chat(
        this.client,
        error ? `\${server_error}: ${error}` : "${server_closed}",
        ygopro.constants.COLORS.RED,
      );
      this.kickClient();
    }
    if (this.clientClosed) {
      this.release();
    }
    if (room) {
      room.serverSessionClosed(this);
    }
  }

  processCtosHook(buffer, ctosProto, follow) {
    if (this.postWatcher) {
      return true;
    }
    const info = ygopro.decodePayload("CTOS", ctosProto, buffer);
    return (
      follow.callback(buffer, info, this.client, this.server) &&
      follow.synchronous
    );
  }

  processStocHook(buffer, stocProto, follow) {
    const info = ygopro.decodePayload("STOC", stocProto, buffer);
    return (
      follow.callback(buffer, info, this.client, this.server) &&
      follow.synchronous
    );
  }

  handleClientData(data) {
    if (this.postWatcher) {
      return;
    }
    this.ctosBuffer = this.ctosBuffer.length
      ? Buffer.concat([this.ctosBuffer, data])
      : data;
    let result;
    try {
      result = ygopro.processPackets(
        this.ctosBuffer,
        ygopro.ctos_follows,
        this.processCtosHook,
      );
    } catch (error) {
      log.warn("bad ctos packet", this.client.ip, error);
      this.ctosBuffer = Buffer.alloc(0);
      this.kickClient();
      return;
    }
    this.ctosBuffer = result.remaining;
    // JOIN_GAME may have converted this session into a halfway watcher.
    if (this.postWatcher) {
      this.ctosBuffer = Buffer.alloc(0);
      this.preEstablishBuffers = [];
      return;
    }
    if (this.established) {
      writeForwarding(this.server, result.forwarding);
    } else if (Buffer.isBuffer(result.forwarding)) {
      this.preEstablishBuffers.push(result.forwarding);
    } else if (result.forwarding) {
      this.preEstablishBuffers.push(...result.forwarding);
    }
  }

  handleServerData(data) {
    this.stocBuffer = this.stocBuffer.length
      ? Buffer.concat([this.stocBuffer, data])
      : data;
    let result;
    try {
      result = ygopro.processPackets(
        this.stocBuffer,
        ygopro.stoc_follows,
        this.processStocHook,
      );
    } catch (error) {
      log.warn("bad stoc packet", this.client.ip, error);
      this.stocBuffer = Buffer.alloc(0);
      this.server.destroy();
      return;
    }
    this.stocBuffer = result.remaining;
    if (!this.clientClosed) {
      const room = this.room;
      if (room?.observerStream?.isJoining()) {
        if (Buffer.isBuffer(result.forwarding)) {
          this.observerGateBuffers.push(result.forwarding);
        } else if (result.forwarding) {
          this.observerGateBuffers.push(...result.forwarding);
        }
      } else {
        writeForwarding(this.client, result.forwarding);
      }
    }
  }

  releaseObserverGate(room) {
    const buffers = this.observerGateBuffers;
    this.observerGateBuffers = [];
    if (!buffers.length || this.room !== room || this.clientClosed) {
      return false;
    }
    writeForwarding(this.client, buffers);
    return true;
  }

  kickClient() {
    if (!this.client.destroyed) {
      this.client.destroy();
    }
  }

  kickServer() {
    this.serverSystemKicked = true;
    if (!this.server.destroyed) {
      this.server.destroy();
    }
  }

  close() {
    this.release();
    this.kickServer();
    this.kickClient();
  }

  release() {
    if (this.terminated) {
      return;
    }
    this.terminated = true;
    this.roomId = null;
    this.drainingRoom = null;
    this.ctosBuffer = Buffer.alloc(0);
    this.stocBuffer = Buffer.alloc(0);
    this.preEstablishBuffers = [];
    this.observerGateBuffers = [];
    this.postWatcher = false;
    SOCKET_sessions.delete(this.client);
    SOCKET_sessions.delete(this.server);
  }
}

net.createServer((client) => new PlayerSession(client).start()).listen(
  settings.port,
  () => {
    log.info("server started", settings.port);
  },
);

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
  ygopro.writePlayerName(buffer, name);
  client.name = name;
  client.vpass = vpass;
  client.name_vpass = vpass ? `${name}$${vpass}` : name;
  client.lang = "zh-cn";
  return false;
});

ygopro.ctos_follow("JOIN_GAME", true, (buffer, info, client) => {
  info.pass = info.pass.trim();
  client.pass = info.pass;
  if (settings.modules.stop) {
    ygopro.stoc_die(client, settings.modules.stop);
    return true;
  } else if (info.pass === "Marshtomp" || info.pass === "the Big Brother") {
    // These names bypass the normal room password in mycard-ygopro server mode.
    ygopro.stoc_die(client, "${bad_user_name}");
    return true;
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
    return true;
  } else if (!info.pass.length) {
    ygopro.stoc_die(client, "${blank_room_name}");
    return true;
  } else if (!client.name || client.name === "") {
    ygopro.stoc_die(client, "${bad_user_name}");
    return true;
  } else if (info.pass.length && !ROOM_validate(info.pass)) {
    ygopro.stoc_die(client, "${invalid_password_room}");
    return true;
  } else {
    const session = getSession(client);
    if (!session || !session.canAttach()) {
      CLIENT_kick(client);
      return true;
    }
    const room = ROOM_find_or_create_by_name(info.pass);
    if (!room) {
      ygopro.stoc_die(client, settings.modules.full);
      return true;
    } else if (room.error) {
      ygopro.stoc_die(client, room.error);
      return true;
    } else if (room.duel_stage !== ygopro.constants.DUEL_STAGE.BEGIN) {
      if (!room.connectWatcher(client)) {
        ygopro.stoc_die(client, "${watch_denied}");
        return true;
      }
      client.setTimeout(300000);
      ygopro.stoc_send_chat_to_room(
        room,
        `${client.name} \${watch_join}`,
        ygopro.constants.COLORS.LIGHTBLUE,
        client,
      );
      ygopro.stoc_send_chat(
        client,
        "${watch_watching}",
        ygopro.constants.COLORS.BABYBLUE,
      );
      return true;
    } else if (
      room.hostinfo.no_watch &&
      room.players.length >= (room.hostinfo.mode === 2 ? 4 : 2)
    ) {
      ygopro.stoc_die(client, "${watch_denied_room}");
      return true;
    } else {
      client.setTimeout(300000); //连接后超时5分钟
      if (!room.connect(client)) {
        ygopro.stoc_die(client, "${create_room_failed}");
        return true;
      }
    }
  }
  return false;
});

ygopro.stoc_follow("JOIN_GAME", false, (buffer, info, client) => {
  //欢迎信息
  const room = getClientRoom(client);
  if (!room) {
    return;
  }
  // Since the server automatically makes the first player to join the room the host, we can't have the observer join beforehand.
  // PlayerSession holds every core response until the observer confirms its own JOIN_GAME.
  room.observerStream?.start(room.port);
  if (settings.modules.welcome) {
    ygopro.stoc_send_chat(
      client,
      settings.modules.welcome,
      ygopro.constants.COLORS.GREEN,
    );
  }
  if (settings.modules.record_match_scores) {
    ygopro.stoc_send_chat_to_room(
      room,
      ROOM_player_get_score(client, ROOM_players_scores),
      ygopro.constants.COLORS.GREEN,
    );
    for (const player of room.players) {
      if (player.pos !== 7 && player !== client) {
        ygopro.stoc_send_chat(
          client,
          ROOM_player_get_score(player, ROOM_players_scores),
          ygopro.constants.COLORS.GREEN,
        );
      }
    }
  }
});

ygopro.stoc_follow("GAME_MSG", true, (buffer, info, client) => {
  const room = getClientRoom(client);
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
  const room = getClientRoom(client);
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
  const room = getClientRoom(client);
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
      const playerSession = getSession(player);
      if (
        client.is_host &&
        room.duel_stage === ygopro.constants.DUEL_STAGE.BEGIN &&
        playerSession
      ) {
        // YGOPro closes the target socket after handling HS_KICK; this is not a room server failure.
        playerSession.serverSystemKicked = true;
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
  const room = getClientRoom(client);
  if (!room) {
    return;
  }
  if (room.duel_stage === ygopro.constants.DUEL_STAGE.BEGIN) {
    //first start
    if (room.lifecycle !== "closing") {
      room.lifecycle = "active";
    }
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
  const room = getClientRoom(client);
  if (!room) {
    return;
  }
  if (room.duel_stage === ygopro.constants.DUEL_STAGE.BEGIN) {
    return true;
  }
  return false;
});

ygopro.ctos_follow("UPDATE_DECK", true, (buffer, info, client) => {
  const room = getClientRoom(client);
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
  const room = getClientRoom(client);
  if (!room) {
    return;
  }
  if (client.pos === 0) {
    room.duel_stage = ygopro.constants.DUEL_STAGE.FINGER;
  }
});

ygopro.stoc_follow("SELECT_TP", false, (buffer, info, client) => {
  const room = getClientRoom(client);
  if (!room) {
    return;
  }
  room.duel_stage = ygopro.constants.DUEL_STAGE.FIRSTGO;
});

ygopro.stoc_follow("CHANGE_SIDE", false, (buffer, info, client) => {
  const room = getClientRoom(client);
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
    response.setHeader("X-Server-Instance-ID", SERVER_INSTANCE_ID);
    if (u.pathname === "/api/getroomscount") {
      const pass_validated = authenticate(u.query.username, u.query.pass);
      if (!settings.modules.http.public_roomlist && !pass_validated) {
        response.writeHead(403, {
          "Content-Type": "application/json; charset=utf-8",
        });
        response.end(
          JSON.stringify({
            serverInstanceId: SERVER_INSTANCE_ID,
            error: "unauthorized",
          }),
        );
        return;
      }
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
            serverInstanceId: SERVER_INSTANCE_ID,
            count: ROOM_all.size,
          }),
        ),
      );
    } else if (u.pathname === "/api/getrooms") {
      const pass_validated = authenticate(u.query.username, u.query.pass);
      if (!settings.modules.http.public_roomlist && !pass_validated) {
        response.writeHead(200);
        response.end(
          addCallback(
            u.query.callback,
            JSON.stringify({
              serverInstanceId: SERVER_INSTANCE_ID,
              rooms: [
                {
                  roomid: "0",
                  roomname: "密码错误",
                  needpass: "true",
                },
              ],
            }),
          ),
        );
      } else {
        const roomsjson = [];
        for (const room of ROOM_all.values()) {
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
              serverInstanceId: SERVER_INSTANCE_ID,
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
            serverInstanceId: SERVER_INSTANCE_ID,
            error: "limit must be a non-negative integer",
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
            serverInstanceId: SERVER_INSTANCE_ID,
            error: "unauthorized",
          }),
        );
        return;
      }
      const limit = u.query.limit != null ? parseInt(u.query.limit, 10) : null;
      const scores = ROOM_get_scores(ROOM_players_scores, limit).map(
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
            serverInstanceId: SERVER_INSTANCE_ID,
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
        for (const room of ROOM_all.values()) {
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
