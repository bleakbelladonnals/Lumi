// Minimal .env loader so the app needs no extra dependency for config.
const fs = require('fs');
const path = require('path');

function load(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2].replace(/\s+#.*$/, '');
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(m[1] in process.env) && value !== '') process.env[m[1]] = value;
  }
}

module.exports = { load };
