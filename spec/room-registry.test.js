"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { RoomRegistry } = require("../room-registry.js");

test("RoomRegistry assigns stable ids and removes both indexes", () => {
  const registry = new RoomRegistry();
  const first = { name: "M#1" };
  const second = { name: "M#2" };

  registry.add(first);
  registry.add(second);

  assert.notEqual(first.id, second.id);
  assert.equal(registry.getByName(first.name), first);
  assert.equal(registry.getById(first.id), first);
  assert.equal(registry.size, 2);
  assert.throws(() => registry.add({ name: first.name }), /already exists/);

  assert.equal(registry.delete(first), true);
  assert.equal(registry.getByName(first.name), undefined);
  assert.equal(registry.getById(first.id), undefined);
  assert.equal(registry.size, 1);
});

test("a stale room cannot remove a replacement with the same name", () => {
  const registry = new RoomRegistry();
  const stale = { name: "M#1" };
  registry.add(stale);
  registry.delete(stale);

  const replacement = { name: stale.name };
  registry.add(replacement);

  assert.equal(registry.delete(stale), false);
  assert.equal(registry.getByName(replacement.name), replacement);
  assert.equal(registry.getById(replacement.id), replacement);
});

test("all active rooms can be removed while iterating the registry", () => {
  const registry = new RoomRegistry();
  for (let index = 0; index < 10; index++) {
    registry.add({ name: `M#${index}` });
  }

  for (const room of registry.values()) {
    registry.delete(room);
  }

  assert.equal(registry.size, 0);
});
