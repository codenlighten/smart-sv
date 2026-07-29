'use strict';

const pow = require('../pow');

/**
 * HeaderChain — the header-only index that drives headers-first sync.
 *
 * During sync a peer first sends us the *headers* of the chain it is offering.
 * Each is 80 bytes and carries its own proof of work, so we can establish which
 * chain has the most work — and therefore which bodies are worth downloading —
 * before pulling a single megabyte of block data. That is the whole point:
 * a peer cannot make us download (or buffer) bodies for a chain it has not
 * actually done the work for, and we fetch bodies in a deliberate order rather
 * than reacting to whatever `inv` arrives.
 *
 * This index is transient scaffolding, not consensus state. Headers are checked
 * for proof of work and for linkage to a block or header we already know; the
 * authoritative contextual and transaction validation still happens in
 * `Blockchain.acceptBlock` when the body arrives. Once a body is connected the
 * corresponding header node is pruned — the block tree is the real record.
 */
class HeaderChain {
  /** @param {Blockchain} chain the node's block tree, used as the anchor */
  constructor(chain) {
    this.chain = chain;
    this.nodes = new Map(); // hash -> { hash, prevHash, height, bits, time, chainwork, header }
  }

  size() {
    return this.nodes.size;
  }

  clear() {
    this.nodes.clear();
  }

  /** Look up a hash in the header index, then the block tree. */
  find(hash) {
    return this.nodes.get(hash) || this.chain.byHash.get(hash) || null;
  }

  /**
   * Add one header.
   * @returns {{status:'added'|'duplicate'|'orphan'|'bad-pow'|'bad-parent', node?:object}}
   */
  add(header) {
    const hash = header.hash;
    if (this.nodes.has(hash) || this.chain.byHash.has(hash)) {
      return { status: 'duplicate', node: this.find(hash) };
    }
    if (!pow.checkProofOfWork(header)) return { status: 'bad-pow' };

    const prevHash = Buffer.from(header.prevHash).reverse().toString('hex');
    const parent = this.find(prevHash);
    if (!parent) return { status: 'orphan' };
    if (parent.invalid) return { status: 'bad-parent' };

    const node = {
      hash,
      prevHash,
      height: parent.height + 1,
      bits: header.bits,
      time: header.time,
      chainwork: parent.chainwork.add(pow.getBlockProof(header.bits)),
      header,
    };
    this.nodes.set(hash, node);
    return { status: 'added', node };
  }

  /**
   * The most-work header tip, or null when no known header beats the block tip
   * (i.e. there is nothing left to sync).
   */
  best() {
    const tip = this.chain.tip();
    let best = null;
    for (const node of this.nodes.values()) {
      if (node.chainwork.lte(tip.chainwork)) continue;
      if (!best || node.chainwork.gt(best.chainwork)) best = node;
    }
    return best;
  }

  /**
   * Hashes of blocks whose bodies we still need, in ascending height along the
   * best header path — the download plan.
   *
   * @param {number} limit           how many to return
   * @param {Set<string>|Map} [skip] hashes already requested from a peer
   */
  missingBodies(limit, skip) {
    const best = this.best();
    if (!best || limit <= 0) return [];

    // Walk back from the best header to the newest ancestor we already have a
    // body for, then hand the path back in connect order.
    const path = [];
    let node = best;
    while (node && !this.chain.byHash.has(node.hash)) {
      path.push(node.hash);
      node = node.prevHash ? this.find(node.prevHash) : null;
    }
    if (!node) return []; // path never reached a block we hold — nothing to do yet
    path.reverse();

    const want = [];
    for (const hash of path) {
      if (skip && skip.has(hash)) continue;
      want.push(hash);
      if (want.length >= limit) break;
    }
    return want;
  }

  /**
   * A block locator over the header chain: hashes from `node` backwards with an
   * exponentially growing step, continuing into the block tree and ending at
   * genesis. Lets a peer resume sending us headers from where we got to.
   */
  locatorFrom(node) {
    const locator = [];
    let step = 1;
    let current = node;
    while (current) {
      locator.push(current.hash);
      if (locator.length > 10) step *= 2;
      for (let i = 0; i < step && current; i++) {
        current = current.prevHash ? this.find(current.prevHash) : null;
      }
    }
    const genesis = this.chain.index[0];
    if (genesis && locator[locator.length - 1] !== genesis.hash) locator.push(genesis.hash);
    return locator;
  }

  /** Drop headers whose bodies have since been accepted into the block tree. */
  prune() {
    for (const hash of this.nodes.keys()) {
      if (this.chain.byHash.has(hash)) this.nodes.delete(hash);
    }
  }

  /** Forget a header subtree rooted at `hash` (its body turned out to be invalid). */
  drop(hash) {
    if (!this.nodes.delete(hash)) return;
    let again = true;
    while (again) {
      again = false;
      for (const [h, n] of this.nodes) {
        if (!this.find(n.prevHash)) {
          this.nodes.delete(h);
          again = true;
        }
      }
    }
  }
}

module.exports = { HeaderChain };
