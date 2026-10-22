'use strict';

const net = require('node:net');

function socketAddress(req) {
  return String((req && req.socket && req.socket.remoteAddress) || 'unknown').replace(/^::ffff:/, '').replace(/%.+$/, '');
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1';
}

function clientAddress(req, trustProxy) {
  const direct = socketAddress(req);
  if (!trustProxy || !isLoopbackAddress(direct)) return direct;
  const values = String(req && req.headers && req.headers['x-forwarded-for'] || '').split(',');
  if (values.length !== 1) return direct;
  const forwarded = values[0].trim();
  return !forwarded.includes('%') && net.isIP(forwarded) ? forwarded : direct;
}

module.exports = { clientAddress, isLoopbackAddress, socketAddress };
