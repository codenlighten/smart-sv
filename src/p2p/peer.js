'use strict';

const EventEmitter = require('events');
const { encode, decode } = require('./messages');

/**
 * A single peer connection: a thin, framed wrapper around a net.Socket. It
 * handles buffering/deframing and exposes `send(command, payload)` plus a
 * `'message'` event carrying decoded { command, payload }. All protocol logic
 * (handshake, sync, relay) lives in the PeerManager.
 */
class Peer extends EventEmitter {
  constructor(socket, opts = {}) {
    super();
    this.socket = socket;
    this.inbound = !!opts.inbound;
    this.buffer = Buffer.alloc(0);

    // Handshake / sync state, managed by the PeerManager.
    this.versionReceived = false;
    this.handshakeDone = false;
    this.height = 0;
    this.userAgent = null;
    this.remoteNonce = null;
    this.known = new Set(); // inv hashes already exchanged, to avoid loops

    this.id = `${socket.remoteAddress || '?'}:${socket.remotePort || '?'}`;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this.emit('close'));
    socket.on('error', (err) => this.emit('error', err));
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let result;
    try {
      result = decode(this.buffer);
    } catch (err) {
      this.emit('error', err);
      this.destroy();
      return;
    }
    this.buffer = result.rest;
    for (const msg of result.messages) this.emit('message', msg);
  }

  send(command, payload) {
    if (this.socket.destroyed) return;
    this.socket.write(encode(command, payload));
  }

  /** Remember that a hash has been exchanged with this peer (relay dedup). */
  markKnown(hash) {
    this.known.add(hash);
    // keep the set bounded
    if (this.known.size > 50000) {
      this.known = new Set([...this.known].slice(-25000));
    }
  }

  destroy() {
    try {
      this.socket.destroy();
    } catch (_) {
      /* already gone */
    }
  }
}

module.exports = { Peer };
