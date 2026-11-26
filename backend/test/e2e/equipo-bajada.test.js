// Fase 4B — bajar de plan con usuarios de más: el dueño elige a quién mantener (desde la app con keepUserIds; por el admin o el
// webhook de Stripe con plazo de 3 días). Nada se borra.
const { ok, run, adminToken, DEMO_KEY } = require('../helpers/harness');
const { login, authH, setPlan, makeUser, j, send, reg, db } = require('../helpers/equipo');

run(async () => {
  const c = await db();
  const ids = async (tenantId) => (await c.query('SELECT id, active FROM team_users WHERE tenant_id = $1', [tenantId])).rows;

  // ── Por el admin (equivale al webhook de Stripe): plazo de 3 días ──
  const O = await reg('Bajada');
  await setPlan(c, O.id, 'business');
  const u1 = await makeUser(O, 'manager', 'Uno');
  const u2 = await makeUser(O, 'seller', 'Dos');
  const u3 = await makeUser(O, 'seller', 'Tres');
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await adminToken() };
  let r = await send(AH, 'PUT', '/api/admin/tenants/' + O.id + '/plan', { plan: 'pro' });
  ok(r.status === 200, 'El admin baja el negocio a Pro (límite 3, hay 4 activos)');
  let t = (await c.query('SELECT team_over_limit_since FROM tenants WHERE id = $1', [O.id])).rows[0];
  ok(t.team_over_limit_since !== null, 'Se marca team_over_limit_since');
  r = await j('/api/team', { headers: O.H });
  ok(r.status === 200 && r.body.overLimit && r.body.overLimit.limit === 3 && r.body.overLimit.activeCount === 4 && r.body.activeCount === 4, 'El dueño ve el aviso de límite superado');
  const dl = new Date(r.body.overLimit.deadline).getTime() - new Date(r.body.overLimit.since).getTime();
  ok(Math.abs(dl - 3 * 86400000) < 1000, 'El plazo es de 3 días');
  r = await j('/api/orders', { headers: u3.H });
  ok(r.status === 200, 'Durante el plazo los demás siguen entrando');
  const html = await fetch(process.env.BASE_URL + '/app?token=' + O.token).then(x => x.text());
  ok(/overLimitSince":"20/.test(html), '/app le avisa al dueño (para el diálogo obligatorio)');
  const htmlU = await fetch(process.env.BASE_URL + '/app?token=' + u1.token).then(x => x.text());
  ok(/__TEAM_USER__/.test(htmlU) && !/overLimitSince":"20/.test(htmlU), '/app no le muestra ese aviso a quien no es dueño');

  // El dueño elige (resolve-limit)
  r = await send(u1.H, 'POST', '/api/team/resolve-limit', { keepUserIds: [] });
  ok(r.status === 403 && r.body.error === 'role_forbidden', 'Solo el dueño resuelve el límite');
  r = await send(O.H, 'POST', '/api/team/resolve-limit', { keepUserIds: [u1.id, u2.id, u3.id] });
  ok(r.status === 400, 'Elegir más de los que caben → 400');
  r = await send(O.H, 'POST', '/api/team/resolve-limit', {});
  ok(r.status === 400, 'Sin lista → 400');
  r = await send(O.H, 'POST', '/api/team/resolve-limit', { keepUserIds: ['no-uuid'] });
  ok(r.status === 400, 'Un id que no es UUID → 400');
  const B = await reg('Bajada Otro');
  await setPlan(c, B.id, 'pro');
  const bu = await makeUser(B, 'seller', 'Ajeno');
  r = await send(O.H, 'POST', '/api/team/resolve-limit', { keepUserIds: [bu.id] });
  ok(r.status === 400, 'Mantener a un usuario de OTRO negocio → 400 (aislamiento)');
  r = await send(O.H, 'POST', '/api/team/resolve-limit', { keepUserIds: [u1.id, u2.id] });
  ok(r.status === 200 && r.body.activeCount === 3 && r.body.overLimit === null && r.body.deactivated === 1, 'Mantiene a 2 más el dueño: desactiva al tercero');
  const rows = await ids(O.id);
  ok(rows.length === 5 - 1 && rows.filter(x => x.active).length === 3, 'Nada se borra: los 4 usuarios siguen en la base (1 desactivado)');
  r = await j('/api/orders', { headers: u3.H });
  ok(r.status === 401 && r.body.error === 'user_inactive', 'El desactivado pierde la sesión al instante');
  r = await j('/api/orders', { headers: u1.H });
  ok(r.status === 200, 'Los que se quedan siguen igual');
  t = (await c.query('SELECT team_over_limit_since FROM tenants WHERE id = $1', [O.id])).rows[0];
  ok(t.team_over_limit_since === null, 'Se limpia el plazo');
  r = await send(O.H, 'POST', '/api/team/resolve-limit', { keepUserIds: [] });
  ok(r.status === 400, 'Si ya cabe, resolve-limit → 400');

  // ── Plazo vencido: se desactiva a los más recientes sin intervención del dueño ──
  const P = await reg('Bajada Plazo');
  await setPlan(c, P.id, 'business');
  const p1 = await makeUser(P, 'seller', 'P1');
  const p2 = await makeUser(P, 'seller', 'P2');
  const p3 = await makeUser(P, 'seller', 'P3');
  // Un orden de creación claro (los más recientes son los que se pierden)
  await c.query(`UPDATE team_users SET created_at = now() - interval '10 days' WHERE id = $1`, [p1.id]);
  await c.query(`UPDATE team_users SET created_at = now() - interval '9 days' WHERE id = $1`, [p2.id]);
  await c.query(`UPDATE team_users SET created_at = now() - interval '8 days' WHERE id = $1`, [p3.id]);
  await send(AH, 'PUT', '/api/admin/tenants/' + P.id + '/plan', { plan: 'pro' });
  await c.query("UPDATE tenants SET team_over_limit_since = now() - interval '2 days' WHERE id = $1", [P.id]);
  r = await j('/api/orders', { headers: p3.H });
  ok(r.status === 200, 'A los 2 días todavía entran todos');
  await c.query("UPDATE tenants SET team_over_limit_since = now() - interval '3 days 1 minute' WHERE id = $1", [P.id]);
  r = await j('/api/orders', { headers: p3.H });
  ok(r.status === 401 && r.body.error === 'user_inactive', 'Pasado el plazo, la petición del más reciente ya no entra');
  r = await j('/api/orders', { headers: p1.H });
  ok(r.status === 200, 'El más antiguo se queda');
  const pr = await ids(P.id);
  ok(pr.filter(x => x.active).length === 3 && pr.length === 4, 'Quedan 3 activos (límite de Pro) y nada se borró');
  t = (await c.query('SELECT team_over_limit_since FROM tenants WHERE id = $1', [P.id])).rows[0];
  ok(t.team_over_limit_since === null, 'El plazo queda limpio');
  const owner = (await c.query("SELECT active FROM team_users WHERE tenant_id = $1 AND role = 'owner'", [P.id])).rows[0];
  ok(owner.active === true, 'El dueño nunca se desactiva');

  // Al subir de plan o reducir usuarios por su cuenta, el plazo desaparece solo
  const Q = await reg('Bajada Sola');
  await setPlan(c, Q.id, 'pro');
  const q1 = await makeUser(Q, 'seller', 'Q1');
  const q2 = await makeUser(Q, 'seller', 'Q2');
  await send(AH, 'PUT', '/api/admin/tenants/' + Q.id + '/plan', { plan: 'basic' });
  ok((await c.query('SELECT team_over_limit_since FROM tenants WHERE id = $1', [Q.id])).rows[0].team_over_limit_since !== null, 'Bajar a Básico con 2 usuarios de más marca el plazo');
  r = await j('/api/team', { headers: Q.H });
  ok(r.status === 200 && r.body.canManage === false && r.body.overLimit, 'En Básico el dueño puede ver el equipo (solo lectura) para elegir');
  r = await send(Q.H, 'POST', '/api/team', { name: 'No', email: 'no' + Date.now() + '@test.local', role: 'seller' });
  ok(r.status === 403 && r.body.error === 'plan_required', 'En Básico no se pueden crear usuarios');
  await send(AH, 'PUT', '/api/admin/tenants/' + Q.id + '/plan', { plan: 'pro' });
  r = await j('/api/orders', { headers: Q.H });
  r = await j('/api/team', { headers: Q.H });
  ok(r.body.overLimit === null && (await c.query('SELECT team_over_limit_since FROM tenants WHERE id = $1', [Q.id])).rows[0].team_over_limit_since === null, 'Volver a Pro limpia el aviso en la siguiente petición');

  // ── Bajada desde la app (demo: demoBilling) con keepUserIds ──
  const demoEmail = 'demobaja' + Date.now() + '@test.local';
  const DH = { 'Content-Type': 'application/json', Authorization: AH.Authorization, 'X-Demo-Key': DEMO_KEY };
  const demo = (await j('/api/admin/demos', { method: 'POST', headers: DH, body: JSON.stringify({ email: demoEmail, businessName: 'Demo Baja', days: 3, sendEmail: false }) })).body;
  const dl2 = (await login(demoEmail, demo.password)).body;
  const D = { H: authH(dl2.token), token: dl2.token };
  const du = [];
  for (let k = 0; k < 3; k++) {
    r = await send(D.H, 'POST', '/api/team', { name: 'Demo' + k, email: 'dm' + k + Date.now() + '.' + String(demo.tenantId).replace(/-/g, '').slice(0, 8) + '@demo.central.test', role: 'seller' });
    ok(r.status === 200, 'La demo crea el usuario ' + (k + 1));
    du.push(r.body.user.id);
  }
  // Bajar a Pro: caben 3 con el dueño; hay 2 usuarios de demo ya contados con los 2 inventados → 6 activos
  const act0 = (await j('/api/team', { headers: D.H })).body;
  r = await send(D.H, 'POST', '/api/billing/create-checkout', { plan: 'pro' });
  ok(r.status === 400 && r.body.error === 'keep_users_required' && r.body.limit === 3 && Array.isArray(r.body.users) && r.body.users.length === act0.activeCount - 1,
    'Demo: bajar de plan sin keepUserIds → 400 con la lista de usuarios para elegir (' + (r.body.users || []).length + ')');
  ok((await j('/api/billing/status', { headers: D.H })).body.plan === 'business', 'Y el plan no cambió');
  r = await send(D.H, 'POST', '/api/billing/create-checkout', { plan: 'pro', keepUserIds: du });
  ok(r.status === 400, 'Elegir más de los que caben → 400 y el plan sigue igual');
  r = await send(D.H, 'POST', '/api/billing/create-checkout', { plan: 'pro', keepUserIds: [du[0], du[1]] });
  ok(r.status === 200 && r.body.plan === 'pro' && r.body.deactivatedUsers === act0.activeCount - 3, 'Demo: con keepUserIds baja de plan y desactiva a los demás en la misma operación');
  const after = (await j('/api/team', { headers: D.H })).body;
  ok(after.activeCount === 3 && after.users.filter(x => x.isOwner)[0].active, 'Quedan 3 activos con el dueño');
  const demoTid = demo.tenantId;
  ok((await ids(demoTid)).length === act0.users.length, 'Los desactivados siguen en la base');
  // Subir de plan no pide nada
  r = await send(D.H, 'POST', '/api/billing/create-checkout', { plan: 'business' });
  ok(r.status === 200 && r.body.plan === 'business', 'Subir de plan no pide elegir');
  await c.end();
});
