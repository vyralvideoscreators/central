// Ejecuta todas las pruebas de CENTRAL:   npm test            (todas)
//                                          npm test -- reports (solo las que contengan "reports")
//
// - Pruebas unitarias: test/*.test.js (no necesitan base de datos).
// - Pruebas e2e: test/e2e/*.test.js. Para ellas se crea una base NUEVA y vacía (central_test)
//   en el Postgres LOCAL, se arranca server.js con Meta simulada y se borra todo al terminar.
//
// SEGURIDAD: solo funciona contra un Postgres local (localhost / 127.0.0.1 / ::1).
// Nunca apuntes TEST_DATABASE_URL a Railway: el runner se niega.
//
// TEST_DATABASE_URL = conexión de ADMINISTRACIÓN al Postgres local (base "postgres"),
// por defecto postgres://postgres@127.0.0.1:55432/postgres
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const ADMIN_URL = process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:55432/postgres';
const TEST_DB = 'central_test';
const PORT = Number(process.env.TEST_PORT || 3990);
const filter = process.argv[2] || '';

function assertLocal(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('TEST_DATABASE_URL no es una URL válida'); }
  if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname) || /railway|rlwy/i.test(url)) {
    throw new Error(`Las pruebas solo corren contra un Postgres LOCAL. Host recibido: "${u.hostname}". ¿Seguro que no es producción?`);
  }
  return u;
}

const files = (dir) => fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(f => f.endsWith('.test.js') && f.includes(filter)).map(f => path.join(dir, f)) : [];

function runFile(file, env) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const p = spawn(process.execPath, [file], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('close', code => resolve({ file: path.relative(ROOT, file), code, out, ms: Date.now() - t0 }));
  });
}

async function waitHealth(ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/health`).then(r => r.json());
      if (r.db) return;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error('El servidor de pruebas no arrancó (¿Postgres local encendido?)');
}

(async () => {
  const results = [];
  const unit = files(__dirname);
  const e2e = files(path.join(__dirname, 'e2e'));

  for (const f of unit) results.push(await runFile(f, process.env));

  let server = null, admin = null;
  if (e2e.length) {
    const u = assertLocal(ADMIN_URL);
    admin = new Client({ connectionString: ADMIN_URL });
    await admin.connect().catch(e => { throw new Error(`No hay Postgres local en ${u.host} (${e.message}). Ver la skill "probar-central".`); });
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    const dbUrl = new URL(ADMIN_URL); dbUrl.pathname = '/' + TEST_DB; dbUrl.search = '?sslmode=disable';

    const metaLog = path.join(os.tmpdir(), `central-meta-${process.pid}.jsonl`);
    const env = {
      ...process.env,
      PORT: String(PORT), DATABASE_URL: dbUrl.toString(), APP_URL: `http://localhost:${PORT}`,
      JWT_SECRET: 'jwt_de_pruebas_locales_0123456789abcdef', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: '',
      ADMIN_EMAIL: 'admin@test.local', ADMIN_PASSWORD: 'adminpass',
      DEMO_CREATION_KEY: '0123456789abcdef0123456789abcdef01234567',
      META_LOG: metaLog,
      // Vacías a propósito: dotenv no las rellena desde un .env local, y nada sale a servicios reales
      RESEND_API_KEY: '', RESEND_FROM: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
      WHATSAPP_TOKEN: '', WHATSAPP_PHONE_NUMBER_ID: '', INSTAGRAM_ACCESS_TOKEN: '', INSTAGRAM_ACCOUNT_ID: '',
      META_APP_SECRET: '', INSTAGRAM_APP_SECRET: '', DEFAULT_TENANT_EMAIL: '', DEFAULT_TENANT_PASSWORD: '',
    };
    let serverLog = '';
    server = spawn(process.execPath, ['--require', path.join(__dirname, 'helpers', 'mock-meta.js'), 'server.js'],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', d => serverLog += d);
    server.stderr.on('data', d => serverLog += d);
    try { await waitHealth(); }
    catch (e) { console.error(serverLog); throw e; }

    const testEnv = { ...env, BASE_URL: `http://127.0.0.1:${PORT}`, TEST_DB_URL: dbUrl.toString() };
    for (const f of e2e) results.push(await runFile(f, testEnv));

    server.kill();
    await new Promise(r => setTimeout(r, 500));
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
    await admin.end();
    try { fs.unlinkSync(metaLog); } catch {}
  }

  let failed = 0;
  for (const r of results) {
    const passes = (r.out.match(/^PASS /gm) || []).length;
    const fails = (r.out.match(/^FAIL /gm) || []).length;
    const okRun = r.code === 0;
    if (!okRun) failed++;
    console.log(`${okRun ? '✔' : '✘'} ${r.file}  (${passes} ok${fails ? `, ${fails} fallos` : ''}, ${(r.ms / 1000).toFixed(1)} s)`);
    if (!okRun) console.log(r.out.split('\n').filter(l => /^FAIL|Error|error/.test(l)).map(l => '    ' + l).join('\n') || r.out);
  }
  if (!results.length) console.log('No hay pruebas que coincidan con "' + filter + '"');
  console.log(failed ? `\n${failed} archivo(s) con fallos` : `\nTodo en verde (${results.length} archivos)`);
  process.exit(failed ? 1 : 0);
})().catch(err => { console.error('✘ ' + err.message); process.exit(1); });
