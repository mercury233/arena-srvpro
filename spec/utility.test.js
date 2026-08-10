"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const defaultHostInfo = require("../data/default_config.json").hostinfo;
const { i18ns, i18nR, roomNameToHostInfo } = require("../utility.js");

const createHostInfo = () => JSON.parse(JSON.stringify(defaultHostInfo));

test("builds the i18n replacement table", () => {
  assert.deepEqual(Object.keys(i18nR), Object.keys(i18ns));
  assert.equal(
    i18nR["zh-cn"].create_room_failed.text,
    i18ns["zh-cn"].create_room_failed,
  );
  assert.equal(
    "${create_room_failed}".replace(
      i18nR["zh-cn"].create_room_failed.regex,
      i18nR["zh-cn"].create_room_failed.text,
    ),
    i18ns["zh-cn"].create_room_failed,
  );
});

test("converts Single, Match and Tag room prefixes to host info", () => {
  const single = roomNameToHostInfo("S#arena", createHostInfo());
  const match = roomNameToHostInfo("M#arena", createHostInfo());
  const tag = roomNameToHostInfo("T#arena", createHostInfo());

  assert.equal(single.mode, 0);
  assert.equal(match.mode, 1);
  assert.equal(tag.mode, 2);
  assert.equal(tag.start_lp, 16000);
  assert.equal(match.replay_mode, 0);
  assert.equal("comment" in match, false);
});

test("converts legacy positional room rules to host info", () => {
  const hostinfo = roomNameToHostInfo(
    "12TTF12000,7,2#arena",
    createHostInfo(),
  );

  assert.equal(hostinfo.rule, 1);
  assert.equal(hostinfo.mode, 2);
  assert.equal(hostinfo.duel_rule, 3);
  assert.equal(hostinfo.no_check_deck, true);
  assert.equal(hostinfo.no_shuffle_deck, false);
  assert.equal(hostinfo.start_lp, 12000);
  assert.equal(hostinfo.start_hand, 7);
  assert.equal(hostinfo.draw_count, 2);
});

test("converts named room rules to host info", () => {
  const hostinfo = roomNameToHostInfo(
    "MATCH,TO,LP12000,TM5,ST7,DR2,LF3,NC,NS,MR4,NW#arena",
    createHostInfo(),
  );

  assert.equal(hostinfo.mode, 1);
  assert.equal(hostinfo.rule, 1);
  assert.equal(hostinfo.start_lp, 12000);
  assert.equal(hostinfo.time_limit, 300);
  assert.equal(hostinfo.start_hand, 7);
  assert.equal(hostinfo.draw_count, 2);
  assert.equal(hostinfo.lflist, 2);
  assert.equal(hostinfo.no_check_deck, true);
  assert.equal(hostinfo.no_shuffle_deck, true);
  assert.equal(hostinfo.duel_rule, 4);
  assert.equal(hostinfo.no_watch, true);
});
