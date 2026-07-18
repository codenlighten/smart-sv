'use strict';

const sv = require('../sv');
const params = require('../params');

/**
 * SmartSV P2P wire protocol.
 *
 * Message framing is Bitcoin-style:
 *
 *   magic    4 bytes   params.networkMagic (UInt32BE) — separates SmartSV traffic
 *   command 12 bytes   ASCII command name, null-padded
 *   length   4 bytes   payload length (UInt32LE)
 *   checksum 4 bytes   first 4 bytes of sha256d(payload)
 *   payload  N bytes
 *
 * Control-message payloads are JSON (compact, robust, easy to evolve). The two
 * bulk commands — `block` and `tx` — carry the raw primitives-library
 * serialization directly, so large blocks aren't hex/JSON-inflated on the wire.
 */

const MAGIC = Buffer.alloc(4);
MAGIC.writeUInt32BE(params.networkMagic >>> 0, 0);

const HEADER_SIZE = 24;
const RAW_COMMANDS = new Set(['block', 'tx']); // payload is a raw buffer, not JSON

function checksum(payload) {
  return sv.crypto.Hash.sha256sha256(payload).slice(0, 4);
}

/**
 * Encode a message. `payload` is a plain object (JSON commands) or a Buffer
 * (raw commands). Returns a Buffer ready to write to a socket.
 */
function encode(command, payload) {
  let body;
  if (RAW_COMMANDS.has(command)) {
    body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  } else {
    body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
  }

  const cmd = Buffer.alloc(12);
  cmd.write(command, 0, 'ascii');

  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length, 0);

  return Buffer.concat([MAGIC, cmd, len, checksum(body), body]);
}

/**
 * Pull as many complete messages as possible from `buffer`.
 * @returns {{ messages: Array<{command:string, payload:*}>, rest: Buffer }}
 * @throws on a magic mismatch (caller should drop the peer).
 */
function decode(buffer) {
  const messages = [];
  let offset = 0;

  while (buffer.length - offset >= HEADER_SIZE) {
    const magic = buffer.slice(offset, offset + 4);
    if (!magic.equals(MAGIC)) {
      throw new Error('bad network magic');
    }
    const command = buffer
      .slice(offset + 4, offset + 16)
      .toString('ascii')
      .replace(/\0+$/, '');
    const length = buffer.readUInt32LE(offset + 16);
    const expectedSum = buffer.slice(offset + 20, offset + 24);

    if (buffer.length - offset - HEADER_SIZE < length) break; // wait for more

    const body = buffer.slice(offset + HEADER_SIZE, offset + HEADER_SIZE + length);
    if (!checksum(body).equals(expectedSum)) {
      throw new Error(`bad checksum for '${command}'`);
    }

    let payload;
    if (RAW_COMMANDS.has(command)) {
      payload = body;
    } else {
      payload = body.length ? JSON.parse(body.toString('utf8')) : {};
    }
    messages.push({ command, payload });
    offset += HEADER_SIZE + length;
  }

  return { messages, rest: buffer.slice(offset) };
}

module.exports = { encode, decode, MAGIC, RAW_COMMANDS };
