"use strict";

const net = require("net");

const ygopro = require("./ygopro.js");

const MARSHTOMP_NAME = "Marshtomp";
const OBSERVER_JOIN_TIMEOUT_MS = 1000;
const JOIN_GAME = Number(ygopro.replace_proto("JOIN_GAME", "STOC"));
const DUEL_END = Number(ygopro.replace_proto("DUEL_END", "STOC"));
const OBSERVER_FOLLOWS = [];
OBSERVER_FOLLOWS[JOIN_GAME] = true;
OBSERVER_FOLLOWS[DUEL_END] = true;

class RoomObserverStream {
  constructor(version, options = {}) {
    this.version = version;
    this.connect = options.connect || net.connect;
    this.onError = options.onError || (() => {});
    this.onReady = options.onReady || (() => {});
    this.onEnd = options.onEnd || (() => {});
    this.joinTimeoutMs =
      options.joinTimeoutMs === undefined
        ? OBSERVER_JOIN_TIMEOUT_MS
        : options.joinTimeoutMs;
    this.buffers = [];
    this.watchers = new Set();
    this.observer = null;
    this.packetBuffer = Buffer.alloc(0);
    this.joinTimer = null;
    this.started = false;
    this.ready = false;
    this.failed = false;
    this.observerEnded = false;
    this.ended = false;
    this.closed = false;
    this.duelEnded = false;
  }

  start(port) {
    if (this.started || this.failed || this.ended || this.closed) {
      return false;
    }

    let observer;
    try {
      observer = this.connect(port, "127.0.0.1", () => {
        if (
          this.failed ||
          this.ready ||
          this.observerEnded ||
          this.ended ||
          this.closed ||
          this.observer !== observer
        ) {
          return;
        }
        // mycard-ygopro server mode reserves this password for its full-information observer.
        ygopro.ctos_send(observer, "PLAYER_INFO", { name: MARSHTOMP_NAME });
        ygopro.ctos_send(observer, "JOIN_GAME", {
          version: this.version,
          pass: MARSHTOMP_NAME,
        });
      });
    } catch (error) {
      this.fail(error);
      return false;
    }

    this.observer = observer;
    this.started = true;
    observer.on("data", (data) => {
      if (this.failed || this.closed) {
        return;
      }
      const buffer = Buffer.from(data);
      this.buffers.push(buffer);
      for (const watcher of this.watchers) {
        if (!watcher.destroyed) {
          watcher.write(buffer);
        }
      }
      this.readPackets(buffer);
    });
    observer.on("error", (error) => {
      this.fail(error);
    });
    observer.on("close", () => {
      if (!this.failed && !this.observerEnded && !this.closed) {
        if (!this.ready) {
          this.fail(new Error("room observer closed before JOIN_GAME"));
          return;
        }
        this.observerEnded = true;
        this.finish();
      }
    });
    if (this.joinTimeoutMs > 0) {
      this.joinTimer = setTimeout(() => {
        this.fail(
          new Error(
            `room observer did not connect and join within ${this.joinTimeoutMs} ms`,
          ),
        );
      }, this.joinTimeoutMs);
      this.joinTimer.unref?.();
    }
    return true;
  }

  addWatcher(watcher) {
    if (
      !this.started ||
      !this.ready ||
      this.failed ||
      this.observerEnded ||
      this.ended ||
      this.closed ||
      !this.observer ||
      this.observer.destroyed ||
      watcher.destroyed
    ) {
      return false;
    }
    this.watchers.add(watcher);
    for (const buffer of this.buffers) {
      watcher.write(buffer);
    }
    return true;
  }

  removeWatcher(watcher) {
    return this.watchers.delete(watcher);
  }

  hasPendingDrain() {
    return this.started && !this.failed && !this.ended && !this.closed;
  }

  isJoining() {
    return (
      this.started &&
      !this.ready &&
      !this.failed &&
      !this.observerEnded &&
      !this.ended &&
      !this.closed
    );
  }

  readPackets(buffer) {
    this.packetBuffer = this.packetBuffer.length
      ? Buffer.concat([this.packetBuffer, buffer])
      : buffer;
    let joined = false;
    try {
      const result = ygopro.processPackets(
        this.packetBuffer,
        OBSERVER_FOLLOWS,
        (payload, proto) => {
          if (proto === JOIN_GAME) {
            joined = true;
          } else if (proto === DUEL_END) {
            this.duelEnded = true;
          }
          return false;
        },
      );
      this.packetBuffer = result.remaining;
    } catch (error) {
      this.fail(new Error("invalid room observer response", { cause: error }));
      return false;
    }
    if (!joined || this.ready) {
      return false;
    }
    this.ready = true;
    this.clearJoinTimer();
    this.onReady();
    return true;
  }

  clearJoinTimer() {
    if (!this.joinTimer) {
      return;
    }
    clearTimeout(this.joinTimer);
    this.joinTimer = null;
  }

  finish() {
    if (this.failed || this.ended || this.closed) {
      return false;
    }
    this.ended = true;
    this.onEnd();
    return true;
  }

  fail(error) {
    if (this.failed || this.observerEnded || this.ended || this.closed) {
      return false;
    }
    this.failed = true;
    this.clearJoinTimer();
    this.packetBuffer = Buffer.alloc(0);
    this.buffers = [];
    this.onError(error);
    for (const watcher of this.watchers) {
      if (!watcher.destroyed) {
        watcher.destroy();
      }
    }
    if (this.observer && !this.observer.destroyed) {
      this.observer.destroy();
    }
    this.onEnd();
    return true;
  }

  close() {
    if (this.closed) {
      return [];
    }
    this.closed = true;
    this.clearJoinTimer();
    this.packetBuffer = Buffer.alloc(0);
    const watchers = Array.from(this.watchers);
    this.watchers.clear();
    this.buffers = [];
    if (this.observer && !this.observer.destroyed) {
      this.observer.destroy();
    }
    return watchers;
  }
}

module.exports = { RoomObserverStream };
