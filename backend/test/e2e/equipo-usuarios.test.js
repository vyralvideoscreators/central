// Fase 4B — rutas de equipo: crear, listar, editar, restablecer; límites por plan; correo único; aislamiento entre negocios.
const { ok, run } = require('../helpers/harness');
const { login, setPlan, makeUser, j, send, reg, db } = require('../helpers/equipo');

run(async () => {
  const c = await db();
  const A = await reg('Equipo A');
  const B = await reg('Equipo B');

  // Básico: sin equipo
  let r = await send(A.H, 'POST', '/api/team', { name: 'Ana', email: 'ana' + Date.now() + '@test.local', role: 'seller' });
  ok(r.status === 403 && r.body.error === 'plan_required', 'Plan básico: crear usuario → 403 plan_required');
  r = await j('/api/team', { headers: A.H });
  ok(r.status === 403 && r.body.error === 'plan_required', 'Plan básico: ver el equipo → 403 plan_required');

  // Pro: límite 3 (dueño + 2)
  await setPlan(c, A.id, 'pro');
  r = await j('/api/team', { headers: A.H });
  ok(r.status === 200 && r.body.limit === 3 && r.body.activeCount === 1 && r.body.users.length === 1 && r.body.users[0].role === 'owner', 'Pro: lista con solo el dueño, límite 3');
  const emailS = 'vend' + Date.now() + '@test.local';
  r = await send(A.H, 'POST', '/api/team', { name: '  Sara   Vendedora ', email: emailS.toUpperCase(), role: 'seller' });
  ok(r.status === 200 && r.body.user.email === emailS && r.body.user.name === 'Sara Vendedora', 'Crear vendedor: nombre limpio y correo en minúsculas');
  ok(typeof r.body.tempPassword === 'string' && r.body.tempPassword.length >= 12 && r.body.user.mustChangePassword === true, 'La contraseña temporal se devuelve una vez y obliga a cambiarla');
  ok(!('password_hash' in r.body.user) && !JSON.stringify(r.body.user).includes('hash'), 'La respuesta no incluye el hash');
  const exp = new Date(r.body.tempPasswordExpiresAt).getTime() - Date.now();
  ok(exp > 6.9 * 86400000 && exp < 7.1 * 86400000, 'La temporal caduca en 7 días');
  const sellerId = r.body.user.id;
  const { rows: [st] } = await c.query('SELECT password_hash FROM team_users WHERE id = $1', [sellerId]);
  ok(st.password_hash.startsWith('$2') && !st.password_hash.includes(r.body.tempPassword), 'La contraseña se guarda con bcrypt (nunca en claro)');
  r = await j('/api/team', { headers: A.H });
  ok(r.body.users.length === 2, 'El listado trae al dueño y al vendedor');
  ok(!JSON.stringify(r.body).includes('"tempPassword"'), 'El listado no lleva ningún campo tempPassword');

  r = await send(A.H, 'POST', '/api/team', { name: 'Marta', email: 'marta' + Date.now() + '@test.local', role: 'manager' });
  ok(r.status === 200 && r.body.user.role === 'manager', 'Crear encargado');
  const managerId = r.body.user.id;
  r = await send(A.H, 'POST', '/api/team', { name: 'Tercero', email: 'tercero' + Date.now() + '@test.local', role: 'seller' });
  ok(r.status === 400 && r.body.error === 'team_limit' && r.body.limit === 3, 'Pro: el cuarto usuario (con el dueño) supera el límite → 400 team_limit');

  // Validaciones
  r = await send(A.H, 'POST', '/api/team', { name: '', email: 'x@test.local', role: 'seller' });
  ok(r.status === 400, 'Nombre vacío → 400');
  r = await send(A.H, 'POST', '/api/team', { name: 'X', email: 'no-es-correo', role: 'seller' });
  ok(r.status === 400, 'Correo inválido → 400');
  r = await send(A.H, 'POST', '/api/team', { name: 'X', email: 'x' + Date.now() + '@test.local', role: 'owner' });
  ok(r.status === 400, 'No se puede crear otro dueño → 400');
  r = await send(A.H, 'POST', '/api/team', { name: 'X', email: 'x' + Date.now() + '@test.local', role: 'admin' });
  ok(r.status === 400, 'Rol desconocido → 400');
  // Dueño nuevo con 10 usuarios: business
  await setPlan(c, A.id, 'business');

  // Correo único en toda la base
  await setPlan(c, B.id, 'pro');
  r = await send(B.H, 'POST', '/api/team', { name: 'Dup', email: emailS, role: 'seller' });
  ok(r.status === 400 && /ya está en uso/.test(r.body.error), 'Correo de un usuario de otro negocio → 400');
  r = await send(B.H, 'POST', '/api/team', { name: 'Dup', email: A.email, role: 'seller' });
  ok(r.status === 400, 'Correo de acceso del dueño de otro negocio → 400');
  r = await send(B.H, 'POST', '/api/team', { name: 'Dup', email: B.email, role: 'seller' });
  ok(r.status === 400, 'Su propio correo de dueño → 400');
  r = await send(A.H, 'POST', '/api/team', { name: 'Dup', email: emailS.toUpperCase(), role: 'seller' });
  ok(r.status === 400, 'El mismo correo en mayúsculas → 400');
  // y al revés: registrar un negocio con el correo de un usuario del equipo
  r = await j('/api/tenant/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ businessName: 'Choque', email: emailS, password: 'password123' }) });
  ok(r.status === 409, 'Registrar un negocio con el correo de un usuario del equipo → 409');
  // y cambiar el correo del dueño al de un usuario del equipo
  r = await send(B.H, 'PUT', '/api/tenant/profile', { email: emailS, currentPassword: 'password123' });
  ok(r.status === 409, 'Cambiar el correo del dueño al de un usuario del equipo → 409');

  // Aislamiento: el dueño de B no toca a los usuarios de A
  r = await send(B.H, 'PATCH', '/api/team/' + sellerId, { active: false });
  ok(r.status === 404, 'B no puede desactivar a un usuario de A (404)');
  r = await send(B.H, 'POST', '/api/team/' + sellerId + '/reset-password', {});
  ok(r.status === 404, 'B no puede restablecer la clave de un usuario de A (404)');
  r = await send(B.H, 'PATCH', '/api/team/' + managerId, { role: 'seller' });
  ok(r.status === 404, 'B no puede cambiar el rol de un usuario de A (404)');
  r = await j('/api/team', { headers: B.H });
  ok(r.status === 200 && r.body.users.length === 1, 'B solo ve su propio equipo');
  r = await send(B.H, 'PATCH', '/api/team/no-es-uuid', { active: false });
  ok(r.status === 404, 'Id que no es UUID → 404');
  const { rows: [bs] } = await c.query('SELECT active, role FROM team_users WHERE id = $1', [sellerId]);
  ok(bs.active === true && bs.role === 'seller', 'El usuario de A quedó intacto');

  // Edición, desactivar, reactivar, restablecer
  r = await send(A.H, 'PATCH', '/api/team/' + sellerId, { name: 'Sara V.', role: 'manager' });
  ok(r.status === 200 && r.body.user.name === 'Sara V.' && r.body.user.role === 'manager', 'Cambiar nombre y rol');
  r = await send(A.H, 'PATCH', '/api/team/' + sellerId, { role: 'seller' });
  ok(r.status === 200 && r.body.user.role === 'seller', 'Volver a vendedor');
  r = await send(A.H, 'PATCH', '/api/team/' + sellerId, { role: 'owner' });
  ok(r.status === 400, 'No se puede ascender a dueño → 400');
  r = await send(A.H, 'PATCH', '/api/team/' + sellerId, {});
  ok(r.status === 400, 'PATCH sin cambios → 400');
  r = await send(A.H, 'PATCH', '/api/team/' + sellerId, { active: 'no' });
  ok(r.status === 400, 'active no booleano → 400');
  const owner = (await j('/api/team', { headers: A.H })).body.users.find(u => u.isOwner);
  r = await send(A.H, 'PATCH', '/api/team/' + owner.id, { active: false });
  ok(r.status === 400, 'No se puede tocar al dueño (ni a uno mismo)');
  r = await send(A.H, 'POST', '/api/team/' + owner.id + '/reset-password', {});
  ok(r.status === 400, 'No se puede restablecer la clave del dueño desde el equipo');
  r = await send(A.H, 'PATCH', '/api/team/' + sellerId, { active: false });
  ok(r.status === 200 && r.body.user.active === false && r.body.user.deactivatedAt, 'Desactivar');
  // desactivado libera plaza
  r = await send(A.H, 'POST', '/api/team', { name: 'Ocupa', email: 'ocupa' + Date.now() + '@test.local', role: 'seller' });
  ok(r.status === 200, 'Business: con uno desactivado todavía caben más');
  const otherId = r.body.user.id;
  r = await send(A.H, 'POST', '/api/team/' + sellerId + '/reset-password', {});
  ok(r.status === 200 && typeof r.body.tempPassword === 'string' && r.body.user.mustChangePassword, 'Restablecer contraseña devuelve una nueva temporal');
  const newTemp = r.body.tempPassword;
  r = await send(A.H, 'PATCH', '/api/team/' + sellerId, { active: true });
  ok(r.status === 200 && r.body.user.active === true && r.body.user.deactivatedAt === null, 'Reactivar');
  ok((await login(emailS, newTemp)).status === 200, 'El usuario reactivado entra con la nueva temporal');

  // Límite de Business (10) también al reactivar
  await setPlan(c, A.id, 'pro');
  r = await send(A.H, 'PATCH', '/api/team/' + otherId, { active: false });
  r = await send(A.H, 'PATCH', '/api/team/' + otherId, { active: true });
  ok(r.status === 400 && r.body.error === 'team_limit', 'Pro: reactivar por encima del límite → 400 team_limit');
  await setPlan(c, A.id, 'business');
  let created = 0, last;
  for (let k = 0; k < 12; k++) {
    last = await send(A.H, 'POST', '/api/team', { name: 'U' + k, email: 'u' + k + '_' + Date.now() + '@test.local', role: 'seller' });
    if (last.status === 200) created++; else break;
  }
  const act = (await j('/api/team', { headers: A.H })).body;
  ok(act.activeCount === 10 && act.limit === 10 && last.status === 400, 'Business: tope de 10 usuarios activos contando al dueño');

  // Quién entra no puede gestionar el equipo
  const sellerLogin = await login(emailS, newTemp);
  r = await j('/api/team', { headers: { Authorization: 'Bearer ' + sellerLogin.body.token } });
  ok(r.status === 403 && r.body.error === 'must_change_password', 'Con la temporal solo se puede cambiar la contraseña');

  await c.end();
});
