// Fase 4B — demos y equipo: dos usuarios inventados, sin cambio de clave, tope de 10, reinicio y «Hacer real» borran a los demás, caducidad.
const { ok, run, adminToken, DEMO_KEY } = require('../helpers/harness');
const { login, authH, j, send, db } = require('../helpers/equipo');

run(async () => {
  const c = await db();
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await adminToken(), 'X-Demo-Key': DEMO_KEY };
  const email = 'demoeq' + Date.now() + '@test.local';
  let r = await send(AH, 'POST', '/api/admin/demos', { email, businessName: 'Demo Equipo', days: 3, sendEmail: false });
  ok(r.status === 200 && Array.isArray(r.body.teamUsers) && r.body.teamUsers.length === 2, 'Crear la demo devuelve 2 usuarios de ejemplo con su contraseña');
  const demo = r.body;
  const mgr = demo.teamUsers.find(u => u.role === 'manager'), sel = demo.teamUsers.find(u => u.role === 'seller');
  ok(mgr && sel && mgr.password && sel.password && /@demo\.central\.test$/.test(mgr.email), 'Encargado y Vendedor con correo de prueba');
  const lm = await login(mgr.email, mgr.password), ls = await login(sel.email, sel.password);
  ok(lm.status === 200 && lm.body.mustChangePassword === false && ls.status === 200, 'Entran con la contraseña mostrada, sin cambio obligatorio (la demo no puede cambiar claves)');
  r = await j('/api/reports?period=mes', { headers: authH(lm.body.token) });
  ok(r.status === 200, 'El encargado de la demo ve informes');
  r = await j('/api/reports?period=mes', { headers: authH(ls.body.token) });
  ok(r.status === 403 && r.body.error === 'role_forbidden', 'El vendedor de la demo no');
  r = await j('/api/team', { headers: authH(ls.body.token) });
  ok(r.status === 403 && r.body.error === 'role_forbidden', 'Ni el equipo');
  r = await j('/api/catalog', { headers: authH(ls.body.token) });
  ok(r.status === 200 && r.body.length > 0 && r.body.every(p => !('cost' in p)), 'El vendedor de la demo no ve costos');
  const dl = await login(email, demo.password);
  const D = authH(dl.body.token);
  r = await j('/api/team', { headers: D });
  ok(r.status === 200 && r.body.users.length === 3 && r.body.limit === 10, 'El dueño de la demo ve al equipo (3 con él, límite 10)');
  // La demo crea usuarios (sin correo enviado) con una clave que sirve mientras dure la demo
  r = await send(D, 'POST', '/api/team', { name: 'Prospecto Uno', email: 'pu' + Date.now() + '@demo.central.test', role: 'seller' });
  ok(r.status === 200 && r.body.user.mustChangePassword === false && r.body.tempPasswordExpiresAt === null, 'La demo crea un usuario sin obligar a cambiar la clave');
  ok((await login(r.body.user.email, r.body.tempPassword)).status === 200, 'y ese usuario entra');
  r = await send(authH(ls.body.token), 'PUT', '/api/tenant/password', { currentPassword: sel.password, newPassword: 'OtraClave-123' });
  ok(r.status === 403 && r.body.error === 'demo_blocked', 'Cambiar contraseña sigue bloqueado en demos');
  // Tope de usuarios (10 en total en la tabla de ese negocio)
  let last, n = 0;
  for (let k = 0; k < 10; k++) { last = await send(D, 'POST', '/api/team', { name: 'U' + k, email: 'u' + k + Date.now() + '@demo.central.test', role: 'seller' }); if (last.status !== 200) break; n++; }
  ok(last.status === 400 || last.status === 429, 'Se llega al tope de usuarios de la demo (' + last.status + ' tras ' + n + ' más)');
  const cnt = (await c.query('SELECT count(*)::int AS n FROM team_users WHERE tenant_id = $1', [demo.tenantId])).rows[0].n;
  ok(cnt <= 10, 'Nunca más de 10 usuarios en la demo (' + cnt + ')');
  // Aislamiento: el cuerpo de una demo no puede enviar correos ni tocar otros negocios (el equipo no llama a servicios externos)
  r = await send(D, 'PATCH', '/api/team/00000000-0000-4000-8000-000000000000', { active: false });
  ok(r.status === 404, 'Un usuario inexistente → 404');

  // Reiniciar datos: se borran los usuarios del prospecto y se recrean los 2 de ejemplo con claves nuevas
  r = await send(AH, 'POST', '/api/admin/demos/' + demo.tenantId + '/reset-data', {});
  const reset = r;
  ok(r.status === 200 && r.body.teamUsers.length === 2, 'Reiniciar datos devuelve los 2 usuarios de ejemplo nuevos');
  const after = (await c.query("SELECT role, count(*)::int AS n FROM team_users WHERE tenant_id = $1 GROUP BY role", [demo.tenantId])).rows;
  ok(after.find(x => x.role === 'owner').n === 1 && after.find(x => x.role === 'manager').n === 1 && after.find(x => x.role === 'seller').n === 1, 'Quedan dueño, encargado y vendedor (los del prospecto se borraron)');
  r = await j('/api/orders', { headers: authH(lm.body.token) });
  ok(r.status === 401, 'La sesión anterior del encargado ya no vale');
  const newMgr = r2 => r2.body.teamUsers.find(u => u.role === 'manager');
  const rm = newMgr(reset);
  ok((await login(rm.email, rm.password)).status === 200 && (await login(mgr.email, mgr.password)).status === 401, 'La clave nueva funciona y la vieja no');
  // Nueva clave: también regenera las de ejemplo
  r = await send(AH, 'POST', '/api/admin/demos/' + demo.tenantId + '/resend', {});
  ok(r.status === 200 && r.body.teamUsers.length === 2 && (await login(email, r.body.password)).status === 200, 'Nueva clave del dueño y de los usuarios de ejemplo');

  // Caducidad: la demo caducada bloquea también al equipo
  const mg2 = newMgr(r);
  const lg = await login(mg2.email, mg2.password);
  ok(lg.status === 200, 'Encargado entra antes de caducar');
  await send(AH, 'POST', '/api/admin/demos/' + demo.tenantId + '/revoke', {});
  r = await j('/api/orders', { headers: authH(lg.body.token) });
  ok(r.status === 403 && r.body.error === 'demo_expired', 'Al caducar la demo, su equipo tampoco entra');
  r = await login(mg2.email, mg2.password);
  ok(r.status === 401, 'Ni por el login: al revocar, el barrido borró a los usuarios que no son el dueño');
  r = await login(email, (await send(AH, 'POST', '/api/admin/demos/' + demo.tenantId + '/resend', {})).body.password || 'x');
  ok(r.status === 403 && r.body.error === 'demo_expired', 'El dueño de la demo caducada tampoco entra (demo_expired)');
  await send(AH, 'POST', '/api/admin/demos/' + demo.tenantId + '/extend', { days: 3 });

  // Hacer real: se borran los usuarios que no son el dueño
  r = await send({ ...AH }, 'POST', '/api/admin/demos/' + demo.tenantId + '/convert', {});
  ok(r.status === 200, 'Convertir en cuenta real');
  const left = (await c.query('SELECT role FROM team_users WHERE tenant_id = $1', [demo.tenantId])).rows;
  ok(left.length === 1 && left[0].role === 'owner', 'Solo queda el dueño: los usuarios de ejemplo se borraron');
  await c.end();
});
