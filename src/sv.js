'use strict';

/**
 * SmartSV cryptographic and transaction/script/block primitives.
 *
 * This is the single point where the underlying primitives library is loaded;
 * the rest of the codebase imports `sv` from here rather than depending on the
 * package directly, so the chain presents its own surface.
 */
module.exports = require('@smartledger/bsv');
