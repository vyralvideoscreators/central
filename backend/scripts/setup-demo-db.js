// Crea la base de datos de demos (central_demo) y su usuario restringido dentro del
// Postgres compartido, y guarda la conexión en el servicio central-demo de Railway.
// No modifica datos ni usuarios existentes: CENTRAL y Kisses and Paws usan el
// usuario administrador "postgres", al que no afecta ningún cambio de este script.
//
// Uso (desde la carpeta backend):
//   railway run --service Postgres node scripts/setup-demo-db.js
const { Client } = require('pg');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ADMIN_URL = process.env.DATABASE_PUBLIC_URL;
if (!ADMIN_URL) { console.log('ERROR: ejecuta este script con: railway run --service Postgres node scripts/setup-demo-db.js'); process.exit(1); }
const pw = crypto.randomBytes(24).toString('hex');
const ssl = process.env.LOCAL_TEST === '1' ? false : { rejectUnauthorized: false };

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL, ssl });
  await admin.connect();
  const who = (await admin.query('SELECT current_user u, current_database() d')).rows[0];
  if (who.u !== 'postgres' || who.d !== 'railway') throw new Error(`conexión inesperada (${who.u}/${who.d})`);

  const roleExists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = 'central_demo_user'")).rowCount;
  await admin.query(`${roleExists ? 'ALTER' : 'CREATE'} ROLE central_demo_user WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${pw}'`);
  console.log(`1/5 Usuario central_demo_user ${roleExists ? 'actualizado' : 'creado'} (sin privilegios de administrador)`);

  if (!(await admin.query("SELECT 1 FROM pg_database WHERE datname = 'central_demo'")).rowCount) {
    await admin.query('CREATE DATABASE central_demo OWNER central_demo_user');
    console.log('2/5 Base de datos central_demo creada');
  } else console.log('2/5 Base de datos central_demo ya existía');

  await admin.query('REVOKE CONNECT ON DATABASE railway FROM PUBLIC');
  await admin.query('REVOKE CONNECT ON DATABASE postgres FROM PUBLIC');
  await admin.query('REVOKE ALL ON DATABASE central_demo FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE central_demo TO central_demo_user');
  await admin.end();

  const demoAsAdmin = new Client({ connectionString: ADMIN_URL.replace(/\/railway(\?|$)/, '/central_demo$1'), ssl });
  await demoAsAdmin.connect();
  await demoAsAdmin.query('ALTER SCHEMA public OWNER TO central_demo_user');
  await demoAsAdmin.end();
  console.log('3/5 Permisos: el usuario de demos solo puede conectarse a central_demo');

  const u = new URL(ADMIN_URL);
  const asDemo = (database) => new Client({ host: u.hostname, port: u.port, user: 'central_demo_user', password: pw, database, ssl });
  const own = asDemo('central_demo');
  await own.connect();
  await own.query('CREATE TABLE IF NOT EXISTS _check (x int)');
  await own.query('DROP TABLE _check');
  await own.end();
  let leak = false;
  for (const db of ['railway', 'postgres']) {
    const c = asDemo(db);
    try { await c.connect(); await c.query('SELECT 1'); leak = true; console.log(`PELIGRO: el usuario de demos puede entrar en ${db}`); }
    catch { /* esperado: sin permiso */ }
    finally { await c.end().catch(() => {}); }
  }
  if (leak) throw new Error('el aislamiento no es correcto; no se guarda la conexión');
  console.log('4/5 Verificado: puede usar central_demo y NO puede entrar a la base de producción');

  if (process.env.LOCAL_TEST === '1') { console.log('5/5 (prueba local: no se guarda en Railway)\n\nLISTO'); return; }
  execFileSync('railway', ['variables', '--service', 'central-demo', '--skip-deploys', '--set',
    `DATABASE_URL=postgresql://central_demo_user:${pw}@postgres.railway.internal:5432/central_demo`], { stdio: 'ignore', shell: process.platform === 'win32' });
  console.log('5/5 Conexión guardada en el servicio central-demo (la contraseña no se muestra)');
  console.log('\nLISTO');
})().catch((e) => { console.log('ERROR:', e.message); process.exit(1); });
