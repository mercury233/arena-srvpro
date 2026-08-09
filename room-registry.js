"use strict";

class RoomRegistry {
  constructor() {
    this.byName = new Map();
    this.byId = new Map();
    this.nextId = 1;
  }

  add(room) {
    if (this.byName.has(room.name)) {
      throw new Error(`room already exists: ${room.name}`);
    }
    room.id = this.nextId++;
    this.byName.set(room.name, room);
    this.byId.set(room.id, room);
  }

  delete(room) {
    if (
      this.byName.get(room.name) !== room ||
      this.byId.get(room.id) !== room
    ) {
      return false;
    }
    this.byName.delete(room.name);
    this.byId.delete(room.id);
    return true;
  }

  getByName(name) {
    return this.byName.get(name);
  }

  getById(id) {
    return this.byId.get(id);
  }

  values() {
    return this.byId.values();
  }

  get size() {
    return this.byId.size;
  }
}

module.exports = { RoomRegistry };
