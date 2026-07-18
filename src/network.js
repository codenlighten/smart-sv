'use strict';

const sv = require('./sv');
const params = require('./params');

/**
 * Register SmartSV as a custom network with the primitives library so that Address,
 * PrivateKey, HDPrivateKey etc. can encode/decode against our chain's version
 * bytes and P2P magic.
 *
 * The version bytes (see params) are chosen so standard addresses round-trip
 * cleanly, while SmartSV keeps its own name and network magic for P2P separation.
 */
let smartsvNetwork = sv.Networks.get(params.name);

if (!smartsvNetwork) {
  smartsvNetwork = sv.Networks.add({
    name: params.name,
    alias: params.chainName,
    pubkeyhash: params.pubkeyhash,
    privatekey: params.privatekey,
    scripthash: params.scripthash,
    xpubkey: params.xpubkey,
    xprivkey: params.xprivkey,
    networkMagic: params.networkMagic,
    port: params.p2pPort,
    dnsSeeds: [],
  });
}

module.exports = {
  network: smartsvNetwork,
};
