// Fase 4B — esquema del equipo: dueño espejo de tenants, trigger, relleno idempotente y reinicio del servidor.
const { ok, j, send, reg, adminToken, db, run } = require('../helpers/harness');
const { Pool } = require('pg');
const team = require('../../equipo');

run(async () => {
  const c = await db();
  const a = await reg('Equipo Esquema A');

  // El registro crea el dueño por el trigger
  let { rows } = await c.query('SELECT * FROM team_users WHERE tenant_id = $1', [a.id]);
  ok(rows.length === 1 && rows[0].role === 'owner' && rows[0].email === a.email, 'el registro crea el usuario dueño con el mismo correo');
  const t0 = (await c.query('SELECT password_hash FROM tenants WHERE id = $1', [a.id])).rows[0];
  ok(rows[0].password_hash === t0.password_hash && rows[0].active && !rows[0].must_change_password, 'el dueño comparte la clave del negocio y no tiene que cambiarla');
  const tv0 = rows[0].token_version;

  // Cambiar la clave desde el perfil (tenants) llega al dueño y sube su token_version
  const r1 = await send(a.H, 'PUT', '/api/tenant/password', { currentPassword: 'password123', newPassword: 'password456' });
  ok(r1.status === 200, 'el dueño cambia su clave');
  ({ rows } = await c.query('SELECT * FROM team_users WHERE tenant_id = $1', [a.id]));
  const t1 = (await c.query('SELECT password_hash FROM tenants WHERE id = $1', [a.id])).rows[0];
  ok(rows[0].password_hash === t1.password_hash && rows[0].token_version > tv0, 'la clave nueva se refleja en el dueño y sube token_version');

  // Cambiar el correo (admin) también se refleja
  const adm = await adminToken();
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm };
  const newEmail = 'nuevo' + Date.now() + '@test.local';
  const r2 = await send(AH, 'PUT', '/api/admin/tenants/' + a.id, { email: newEmail });
  ok(r2.status === 200, 'el admin cambia el correo del negocio');
  ({ rows } = await c.query('SELECT email FROM team_users WHERE tenant_id = $1 AND role = $2', [a.id, 'owner']));
  ok(rows[0].email === newEmail, 'el correo nuevo se refleja en el dueño');

  // Correo repetido entre negocios: el segundo no puede registrarse ni cambiarse a él
  const b = await reg('Equipo Esquema B');
  const dup = await j('/api/tenant/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: 'Dup', email: newEmail.toUpperCase(), password: 'password123' }) });
  ok(dup.status === 409, 'registrar un correo ya usado (aunque cambie la mayúscula) da 409');
  const r3 = await send(AH, 'PUT', '/api/admin/tenants/' + b.id, { email: newEmail });
  ok(r3.status === 409, 'cambiar el correo de B al de A da 409');

  // Relleno idempotente: sin dueño → se crea; segunda vez no cambia nada
  await c.query("DELETE FROM team_users WHERE tenant_id = $1", [b.id]);
  const pool = new Pool({ connectionString: process.env.TEST_DB_URL });
  const bf1 = await team.runTeamBackfill(pool);
  ok(bf1.created >= 1, 'el relleno recrea el dueño que faltaba');
  const n1 = (await c.query('SELECT count(*)::int AS n FROM team_users')).rows[0].n;
  const bf2 = await team.runTeamBackfill(pool);
  const n2 = (await c.query('SELECT count(*)::int AS n FROM team_users')).rows[0].n;
  ok(bf2.created === 0 && bf2.resynced === 0 && n1 === n2, 'el relleno repetido (reinicio) no cambia nada');
  // El espejo se corrige si algo desfasó el dueño
  await c.query("UPDATE team_users SET password_hash = 'x' WHERE tenant_id = $1 AND role = 'owner'", [b.id]);
  const bf3 = await team.runTeamBackfill(pool);
  ok(bf3.resynced === 1, 'el relleno corrige un dueño desfasado');
  // El esquema también se puede asegurar otra vez sin error (reinicio)
  ok(await team.ensureTeamSchema(pool) === true, 'ensureTeamSchema es idempotente');
  const fk = await c.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname LIKE '%\\_user\\_id\\_fk'");
  ok(fk.rows[0].n === team.USER_FK_COLUMNS.length, 'hay una FK por cada columna «quién hizo qué»');
  const tr = await c.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'tenants_team_sync_%' AND NOT tgisinternal");
  ok(tr.rows[0].n === 2, 'los dos triggers del espejo existen');
  // Un solo dueño por negocio
  const dupOwner = await c.query("INSERT INTO team_users (tenant_id, name, email, password_hash, role) VALUES ($1,'x','otro@test.local','h','owner')", [a.id]).then(() => true, () => false);
  ok(dupOwner === false, 'no puede haber dos dueños en el mismo negocio');

  await pool.end();
  await c.end();
});
