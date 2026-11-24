// Servidor CENTRAL de desarrollo para probar a mano en el navegador:
//   node test/servidor-local.js        → http://localhost:3999
//
// - Usa la base LOCAL "central_dev" (se crea si no existe y se CONSERVA entre arranques).
// - Meta simulada: nada sale a WhatsApp/Instagram; las llamadas quedan en test/.meta-calls.jsonl
// - Sin Stripe, Resend ni ninguna otra clave real. Admin: admin@test.local / adminpass
// - Se niega a usar un Postgres que no sea local.
// Variables opcionales: TEST_DATABASE_URL (conexión admin al Postgres local), DEV_PORT.
const { spawn } = require('child_process');
const path = require('path');
const { Client } = require('pg');
const { DEFAULT_ADMIN_URL, assertLocalDb, dbUrlFor, serverEnv, MOCK_META } = require('./helpers/local-env');

const ADMIN_URL = process.env.TEST_DATABASE_URL || DEFAULT_ADMIN_URL;
const PORT = Number(process.env.DEV_PORT || 3999);
const DEV_DB = 'central_dev';

(async () => {
  assertLocalDb(ADMIN_URL);
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect().catch(e => { throw new Error(`No hay Postgres local (${e.message}). Ver la skill "probar-central".`); });
  const { rows } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [DEV_DB]);
  if (!rows[0]) { await admin.query(`CREATE DATABASE ${DEV_DB}`); console.log(`Base local ${DEV_DB} creada`); }
  await admin.end();

  const env = serverEnv({ port: PORT, dbUrl: dbUrlFor(ADMIN_URL, DEV_DB), metaLog: path.join(__dirname, '.meta-calls.jsonl') });
  const server = spawn(process.execPath, ['--require', MOCK_META, 'server.js'],
    { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' });
  console.log(`CENTRAL local en http://localhost:${PORT}  (admin: admin@test.local / adminpass)`);
  const stop = () => { server.kill(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  server.on('exit', code => process.exit(code || 0));
})().catch(err => { console.error('✘ ' + err.message); process.exit(1); });
