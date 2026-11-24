// Utilidades comunes de las pruebas e2e. Las variables las pone test/run.js.
const fs = require('fs');
const { Client } = require('pg');

const BASE = process.env.BASE_URL;
const DB_URL = process.env.TEST_DB_URL;
const META_LOG = process.env.META_LOG;
if (!BASE || !DB_URL) {
  console.error('Ejecuta las pruebas con `npm test` (test/run.js), no sueltas.');
  process.exit(2);
}

let fails = 0;
function ok(cond, msg) {
  console.log((cond ? 'PASS ' : 'FAIL ') + msg);
  if (!cond) fails++;
}

// Petición a la API: { status, body }
const j = (u, o = {}) => fetch(BASE + u, o).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
const send = (H, method, u, body) => j(u, { method, headers: H, body: JSON.stringify(body) });

// Registra un negocio nuevo y devuelve { id, token, H } (H = cabeceras con JSON + token)
async function reg(name) {
  const email = name.replace(/\W/g, '').toLowerCase() + Date.now() + Math.floor(Math.random() * 1e6) + '@test.local';
  const r = await j('/api/tenant/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: name, email, password: 'password123' }),
  });
  if (!r.body || !r.body.token) throw new Error('No se pudo registrar el negocio de prueba: ' + JSON.stringify(r.body));
  return { id: r.body.tenant.id, email, token: r.body.token,
    H: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + r.body.token } };
}

async function adminToken() {
  const r = await j('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }) });
  return r.body.token;
}

async function db() {
  const c = new Client({ connectionString: DB_URL });
  await c.connect();
  return c;
}

// Llamadas que el servidor intentó hacer a Meta (ver helpers/mock-meta.js)
function metaCalls() {
  if (!META_LOG || !fs.existsSync(META_LOG)) return [];
  return fs.readFileSync(META_LOG, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}
function clearMeta() { if (META_LOG && fs.existsSync(META_LOG)) fs.unlinkSync(META_LOG); }

// Ejecuta la prueba y termina con el código correcto
function run(fn) {
  fn().then(() => {
    console.log(fails ? `\n${fails} FALLO(S)` : '\nTODO OK');
    process.exit(fails ? 1 : 0);
  }).catch(err => { console.error(err); process.exit(1); });
}

module.exports = { ok, j, send, reg, adminToken, db, metaCalls, clearMeta, run,
  DEMO_KEY: process.env.DEMO_CREATION_KEY };
