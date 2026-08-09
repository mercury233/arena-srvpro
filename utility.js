"use strict";

const fs = require("fs");

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

function roomNameToHostInfo(name, hostinfo) {
  delete hostinfo.comment;

  let param;
  if (name.startsWith("M#")) {
    hostinfo.mode = 1;
  } else if (name.startsWith("T#")) {
    hostinfo.mode = 2;
    hostinfo.start_lp = 16000;
  } else if (
    (param = name.match(/^(\d)(\d)(T|F)(T|F)(T|F)(\d+),(\d+),(\d+)/i))
  ) {
    hostinfo.rule = parseInt(param[1]);
    hostinfo.mode = parseInt(param[2]);
    if (param[3] === "T") {
      hostinfo.duel_rule = 3;
    }
    hostinfo.no_check_deck = param[4] === "T";
    hostinfo.no_shuffle_deck = param[5] === "T";
    hostinfo.start_lp = parseInt(param[6]);
    hostinfo.start_hand = parseInt(param[7]);
    hostinfo.draw_count = parseInt(param[8]);
  } else if ((param = name.match(/(.+)#/)) !== null) {
    const rule = param[1].toUpperCase();
    if (rule.match(/(^|，|,)(M|MATCH)(，|,|$)/)) {
      hostinfo.mode = 1;
    }
    if (rule.match(/(^|，|,)(T|TAG)(，|,|$)/)) {
      hostinfo.mode = 2;
      hostinfo.start_lp = 16000;
    }
    if (rule.match(/(^|，|,)(TCGONLY|TO)(，|,|$)/)) {
      hostinfo.rule = 1;
    }
    if (rule.match(/(^|，|,)(OCGONLY|OO)(，|,|$)/)) {
      hostinfo.rule = 0;
    }
    if (rule.match(/(^|，|,)(SC|CCG)(，|,|$)/)) {
      hostinfo.rule = 2;
      hostinfo.lflist = -1;
    }
    if (rule.match(/(^|，|,)(OT|TCG)(，|,|$)/)) {
      hostinfo.rule = 5;
    }
    if ((param = rule.match(/(^|，|,)LP(\d+)(，|,|$)/))) {
      let start_lp = parseInt(param[2]);
      if (start_lp <= 0) {
        start_lp = 1;
      }
      if (start_lp >= 99999) {
        start_lp = 99999;
      }
      hostinfo.start_lp = start_lp;
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
      hostinfo.time_limit = time_limit;
    }
    if ((param = rule.match(/(^|，|,)(START|ST)(\d+)(，|,|$)/))) {
      let start_hand = parseInt(param[3]);
      if (start_hand <= 0) {
        start_hand = 1;
      }
      if (start_hand >= 40) {
        start_hand = 40;
      }
      hostinfo.start_hand = start_hand;
    }
    if ((param = rule.match(/(^|，|,)(DRAW|DR)(\d+)(，|,|$)/))) {
      let draw_count = parseInt(param[3]);
      if (draw_count >= 35) {
        draw_count = 35;
      }
      hostinfo.draw_count = draw_count;
    }
    if ((param = rule.match(/(^|，|,)(LFLIST|LF)(\d+)(，|,|$)/))) {
      const lflist = parseInt(param[3]) - 1;
      hostinfo.lflist = lflist;
    }
    if (rule.match(/(^|，|,)(NOLFLIST|NF)(，|,|$)/)) {
      hostinfo.lflist = -1;
    }
    if (rule.match(/(^|，|,)(NOUNIQUE|NU)(，|,|$)/)) {
      hostinfo.rule = 4;
    }
    if (rule.match(/(^|，|,)(NOCHECK|NC)(，|,|$)/)) {
      hostinfo.no_check_deck = true;
    }
    if (rule.match(/(^|，|,)(NOSHUFFLE|NS)(，|,|$)/)) {
      hostinfo.no_shuffle_deck = true;
    }
    if (rule.match(/(^|，|,)(IGPRIORITY|PR)(，|,|$)/)) {
      hostinfo.duel_rule = 4;
    }
    if ((param = rule.match(/(^|，|,)(DUELRULE|MR)(\d+)(，|,|$)/))) {
      const duel_rule = parseInt(param[3]);
      if (duel_rule && duel_rule > 0 && duel_rule <= 5) {
        hostinfo.duel_rule = duel_rule;
      }
    }
    if (rule.match(/(^|，|,)(NOWATCH|NW)(，|,|$)/)) {
      hostinfo.no_watch = true;
    }
  }

  hostinfo.replay_mode = 0;
  return hostinfo;
}

module.exports = {
  i18ns,
  i18nR,
  roomNameToHostInfo,
};
