'use strict';

/**
 * A tiny leveled logger. Emits plain text by default (readable in journald) or
 * one-line JSON when `json: true` (friendly to log shippers). No dependencies.
 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function createLogger(opts = {}) {
  const threshold = LEVELS[opts.level] != null ? LEVELS[opts.level] : LEVELS.info;
  const json = !!opts.json;
  const base = opts.name ? { name: opts.name } : {};

  function emit(level, msg, fields) {
    if (LEVELS[level] > threshold) return;
    const ts = new Date().toISOString();
    if (json) {
      const line = JSON.stringify({ ts, level, msg, ...base, ...(fields || {}) });
      write(level, line);
    } else {
      const extra = fields ? ' ' + JSON.stringify(fields) : '';
      write(level, `${ts} ${level.toUpperCase().padEnd(5)} ${msg}${extra}`);
    }
  }

  function write(level, line) {
    if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  return {
    error: (m, f) => emit('error', m, f),
    warn: (m, f) => emit('warn', m, f),
    info: (m, f) => emit('info', m, f),
    debug: (m, f) => emit('debug', m, f),
    child: (name) => createLogger({ ...opts, name }),
  };
}

module.exports = { createLogger };
