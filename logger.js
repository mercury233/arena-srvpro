'use strict';

const util = require('util');

exports.createLogger = function createLogger(options = {}) {
  const name = options.name || 'app';
  const write = (stream, level, args) => {
    stream.write(`${new Date().toISOString()} [${level}] ${name}: ${util.format(...args)}\n`);
  };

  return {
    info(...args) {
      write(process.stdout, 'INFO', args);
    },
    warn(...args) {
      write(process.stderr, 'WARN', args);
    },
    error(...args) {
      write(process.stderr, 'ERROR', args);
    }
  };
};
