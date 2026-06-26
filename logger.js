'use strict';

const fs = require('fs');
const path = require('path');

const LOGS_DIR = path.join(__dirname, 'logs');
const LOG_FILE = path.join(LOGS_DIR, 'gateway.log');

fs.mkdirSync(LOGS_DIR, { recursive: true });

function logEvent(entry) {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
  try {
    fs.appendFileSync(LOG_FILE, line, 'utf8');
  } catch (err) {
    console.error('[Logger] Failed to write to gateway.log:', err.message);
  }
}

module.exports = { logEvent };
