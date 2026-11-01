// Tiny JSON-file store. Good enough for a demo; production would use Postgres.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');

const EMPTY = () => ({
  users: [],
  posts: [],
  proposals: [],
  links: [],
  clicks: [],
  orders: [],
  checkouts: [],
  subscriptions: [],
  events: [],
  outbox: [],
});

let db = load();
let timer = null;

function load() {
  try {
    return { ...EMPTY(), ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch {
    return EMPTY();
  }
}

// Debounced atomic write: write to a temp file, then rename.
function save() {
  clearTimeout(timer);
  timer = setTimeout(flush, 50);
}

function flush() {
  clearTimeout(timer);
  const tmp = DB_FILE + '.tmp';
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function reset() {
  db = EMPTY();
  flush();
}

const id = (prefix) => `${prefix}_${crypto.randomBytes(5).toString('hex')}`;

// Event names accepted from the browser. Everything else is server-side only.
const CLIENT_EVENTS = new Set(['landing_view', 'report_viewed', 'paywall_view']);

function track(name, props = {}, source = 'server') {
  const event = {
    event_id: props.event_id || id('evt'),
    name,
    source,
    ts: new Date().toISOString(),
    ...props,
  };
  db.events.push(event);
  if (db.events.length > 5000) db.events.splice(0, db.events.length - 5000);
  save();
  return event;
}

module.exports = {
  get db() { return db; },
  save,
  flush,
  reset,
  id,
  track,
  CLIENT_EVENTS,
};
