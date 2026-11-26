// Fase 4B — sesiones por usuario: contraseña temporal, desactivar → 401 al instante (HTTP y WebSocket), cambio de rol sin volver a
// entrar, token antiguo sin userId = dueño, token con rol falsificado, freno de login por usuario.
const jwt = require('jsonwebtoken');
const { ok, run } = require('../helpers/harness');
const { login, authH, setPlan, makeUser, j, send, reg, db } = require('../helpers/equipo');

const wsUrl = process.env.BASE_URL.replace('http', 'ws') + '/ws';
// Abre un WebSocket, se autentica y resuelve con { ws, msgs, closed() }
function openWs(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const msgs = [];
    let closed = false;
    ws.onmessage = (e) => { const m = JSON.parse(e.data); msgs.push(m); if (m.type === 'init' || m.type === 'auth_error') resolve({ ws, msgs, closed: () => closed }); };
    ws.onclose = () => { closed = true; resolve({ ws, msgs, closed: () => closed }); };
    ws.onerror = () => {};
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
    setTimeout(() => reject(new Error('WebSocket sin respuesta')), 8000);
  });
}
const waitFor = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

run(async () => {
  const c = await db();
  const O = await reg('Sesiones');
  await setPlan(c, O.id, 'business');

  // ── Contraseña temporal ──
  const email = 'sara' + Date.now() + '@test.local';
  let r = await send(O.H, 'POST', '/api/team', { name: 'Sara', email, role: 'seller' });
  const temp = r.body.tempPassword, sid = r.body.user.id;
  r = await login(email, 'incorrecta');
  ok(r.status === 401, 'Login con clave incorrecta → 401');
  r = await login(email, temp);
  ok(r.status === 200 && r.body.mustChangePassword === true && r.body.user.role === 'seller' && r.body.tenant.fullName === 'Sara', 'Login con la temporal: pide cambiarla');
  const tok1 = r.body.token;
  const sockTemp = await openWs(tok1);
  ok(sockTemp.msgs.some(m => m.type === 'must_change_password') && !sockTemp.msgs.some(m => m.type === 'auth_error' || m.type === 'init'), 'Con la temporal el WebSocket no da datos ni auth_error (la app no se recarga en bucle)');
  const dec = jwt.decode(tok1);
  ok(dec.userId === sid && dec.role === 'seller' && Number.isInteger(dec.tv) && dec.tid === O.id && dec.tenantId === undefined, 'El token del vendedor lleva tid, userId, role y tv, y NO tenantId (la 4A lo rechazaría)');
  r = await j('/api/orders', { headers: authH(tok1) });
  ok(r.status === 403 && r.body.error === 'must_change_password', 'Con la temporal, cualquier otra ruta → 403 must_change_password');
  r = await j('/api/tenant/profile', { headers: authH(tok1) });
  ok(r.status === 403 && r.body.error === 'must_change_password', 'Incluida la del perfil');
  r = await send(authH(tok1), 'PUT', '/api/tenant/password', { currentPassword: temp, newPassword: 'corta' });
  ok(r.status === 400, 'La clave nueva debe tener 8 caracteres');
  r = await send(authH(tok1), 'PUT', '/api/tenant/password', { currentPassword: 'mala', newPassword: 'ClaveNueva-1' });
  ok(r.status === 401, 'Cambiar con la actual incorrecta → 401');
  r = await send(authH(tok1), 'PUT', '/api/tenant/password', { currentPassword: temp, newPassword: 'ClaveNueva-1' });
  ok(r.status === 200 && !!r.body.token, 'Cambiar la temporal → 200 con token nuevo');
  const tok2 = r.body.token;
  r = await j('/api/orders', { headers: authH(tok1) });
  ok(r.status === 401 && r.body.error === 'session_closed', 'El token anterior queda cerrado');
  r = await j('/api/orders', { headers: authH(tok2) });
  ok(r.status === 200, 'El token nuevo entra con normalidad');
  r = await login(email, temp);
  ok(r.status === 401, 'La temporal ya no sirve');
  r = await login(email, 'ClaveNueva-1');
  ok(r.status === 200 && r.body.mustChangePassword === false, 'Login con la clave nueva ya no pide cambiarla');
  ok((await c.query('SELECT last_login_at FROM team_users WHERE id = $1', [sid])).rows[0].last_login_at !== null, 'Se guarda el último acceso');
  const sellerTok = r.body.token;

  // La clave del usuario no cambia la del dueño (ni al revés)
  ok((await login(O.email, 'password123')).status === 200, 'La clave del dueño no cambió');

  // ── Temporal caducada ──
  const e2 = 'cad' + Date.now() + '@test.local';
  r = await send(O.H, 'POST', '/api/team', { name: 'Caduca', email: e2, role: 'seller' });
  const t2 = r.body.tempPassword, id2 = r.body.user.id;
  const early = await login(e2, t2);
  await c.query("UPDATE team_users SET temp_password_expires_at = now() - interval '1 minute' WHERE id = $1", [id2]);
  r = await login(e2, t2);
  ok(r.status === 401 && r.body.error === 'temp_password_expired' && /caducó/.test(r.body.message), 'Temporal caducada → 401 con mensaje claro');
  r = await j('/api/tenant/profile', { headers: authH(early.body.token) });
  ok(r.status === 401 && r.body.error === 'temp_password_expired', 'Una sesión abierta con la temporal caducada tampoco sigue');
  r = await send(O.H, 'POST', '/api/team/' + id2 + '/reset-password', {});
  ok(r.status === 200 && (await login(e2, r.body.tempPassword)).status === 200, 'El dueño genera una temporal nueva y funciona');

  // ── Desactivar → 401 inmediato (HTTP y WebSocket) ──
  const sock = await openWs(sellerTok);
  ok(sock.msgs.some(m => m.type === 'init') && !sock.closed(), 'El WebSocket del vendedor se autentica y recibe los datos');
  r = await send(O.H, 'PATCH', '/api/team/' + sid, { active: false });
  ok(r.status === 200, 'El dueño desactiva al vendedor');
  r = await j('/api/orders', { headers: authH(sellerTok) });
  ok(r.status === 401 && r.body.error === 'user_inactive', 'Su token deja de valer al instante (401 user_inactive)');
  ok(await waitFor(() => sock.closed()), 'Su WebSocket abierto se cierra');
  r = await login(email, 'ClaveNueva-1');
  ok(r.status === 403 && r.body.error === 'user_inactive', 'Login de un usuario desactivado → 403 user_inactive');
  const sock2 = await openWs(sellerTok);
  ok(sock2.msgs.some(m => m.type === 'auth_error') && !sock2.msgs.some(m => m.type === 'init'), 'Un WebSocket nuevo con ese token se rechaza');
  const htmlApp = await fetch(process.env.BASE_URL + '/app?token=' + sellerTok).then(x => x.text());
  ok(!htmlApp.includes('__TEAM_USER__') && /removeItem/.test(htmlApp), '/app no sirve la aplicación a un usuario desactivado');
  await send(O.H, 'PATCH', '/api/team/' + sid, { active: true });
  r = await j('/api/orders', { headers: authH(sellerTok) });
  ok(r.status === 401, 'Reactivarlo no revive el token viejo (hay que volver a entrar)');
  r = await login(email, 'ClaveNueva-1');
  ok(r.status === 200, 'Reactivado: entra otra vez');
  const sellerTok2 = r.body.token;

  // ── Cambio de rol efectivo sin volver a entrar ──
  r = await j('/api/reports?period=mes', { headers: authH(sellerTok2) });
  ok(r.status === 403 && r.body.error === 'role_forbidden', 'Vendedor: informes → 403 role_forbidden');
  const sockR = await openWs(sellerTok2);
  r = await send(O.H, 'PATCH', '/api/team/' + sid, { role: 'manager' });
  ok(r.status === 200, 'El dueño lo ascende a encargado');
  r = await j('/api/reports?period=mes', { headers: authH(sellerTok2) });
  ok(r.status === 200, 'El MISMO token ya ve informes (el rol se lee de la base)');
  ok(await waitFor(() => sockR.msgs.some(m => m.type === 'role_changed' && m.role === 'manager')), 'Su pantalla recibe el aviso de cambio de rol por WebSocket');
  r = await send(O.H, 'PATCH', '/api/team/' + sid, { role: 'seller' });
  r = await j('/api/reports?period=mes', { headers: authH(sellerTok2) });
  ok(r.status === 403, 'Y al volver a vendedor, vuelve a estar prohibido sin reentrar');
  sockR.ws.close();

  // ── Token falsificado: el rol del token no cuenta ──
  const forged = jwt.sign({ tenantId: O.id, userId: sid, role: 'owner', tv: jwt.decode(sellerTok2).tv, email }, process.env.JWT_SECRET, { expiresIn: '1h' });
  r = await j('/api/team', { headers: authH(forged) });
  ok(r.status === 403 && r.body.error === 'role_forbidden', 'Un token que dice «owner» sigue siendo vendedor (el rol sale de la base)');
  const wrongTv = jwt.sign({ tenantId: O.id, userId: sid, role: 'seller', tv: 999, email }, process.env.JWT_SECRET, { expiresIn: '1h' });
  r = await j('/api/orders', { headers: authH(wrongTv) });
  ok(r.status === 401, 'Un token con token_version equivocado → 401');
  const noTv = jwt.sign({ tenantId: O.id, userId: sid, role: 'seller', email }, process.env.JWT_SECRET, { expiresIn: '1h' });
  r = await j('/api/orders', { headers: authH(noTv) });
  ok(r.status === 401, 'Un token con userId pero sin token_version → 401');
  // un userId de OTRO negocio con mi tenantId no entra
  const O2 = await reg('Sesiones Otro');
  const other = await db();
  const { rows: [o2owner] } = await other.query("SELECT id, token_version FROM team_users WHERE tenant_id = $1 AND role = 'owner'", [O2.id]);
  const cross = jwt.sign({ tenantId: O.id, userId: o2owner.id, role: 'owner', tv: o2owner.token_version }, process.env.JWT_SECRET, { expiresIn: '1h' });
  r = await j('/api/orders', { headers: authH(cross) });
  ok(r.status === 401, 'El usuario de otro negocio con mi tenantId no entra');
  await other.end();

  // ── Token antiguo (sin userId) = dueño ──
  const legacy = jwt.sign({ tenantId: O.id, email: O.email }, process.env.JWT_SECRET, { expiresIn: '30d' });
  r = await j('/api/team', { headers: authH(legacy) });
  ok(r.status === 200 && r.body.users.some(u => u.isOwner), 'Un token antiguo (solo tenantId y email) vale como el dueño');
  r = await j('/api/tenant/profile', { headers: authH(legacy) });
  ok(r.status === 200, 'y sigue funcionando en el resto de rutas');
  const sockL = await openWs(legacy);
  ok(sockL.msgs.some(m => m.type === 'init'), 'y en el WebSocket');
  sockL.ws.close();

  // Cambiar la clave del dueño cierra sus sesiones nuevas pero no estorba a las demás personas
  const ownerTok = (await login(O.email, 'password123')).body.token;
  r = await send(authH(ownerTok), 'PUT', '/api/tenant/password', { currentPassword: 'password123', newPassword: 'password456' });
  r = await j('/api/team', { headers: authH(ownerTok) });
  ok(r.status === 401, 'Tras cambiar la clave del dueño, su token anterior se cierra');
  r = await j('/api/team', { headers: authH(legacy) });
  ok(r.status === 401 && r.body.error === 'session_closed', 'y también el token antiguo sin userId (el dueño ya cambió su clave)');
  const ownerNew = jwt.decode((await login(O.email, 'password456')).body.token);
  ok(ownerNew.tenantId === O.id && ownerNew.tid === O.id, 'El token del dueño conserva tenantId (compatible con la 4A) y lleva tid');
  r = await j('/api/orders', { headers: authH(sellerTok2) });
  ok(r.status === 200, 'La sesión del vendedor no se ve afectada');
  // Negocio suspendido: nadie del equipo entra
  await c.query('UPDATE tenants SET active = false WHERE id = $1', [O.id]);
  r = await j('/api/orders', { headers: authH(sellerTok2) });
  ok(r.status === 403, 'Negocio suspendido: el equipo tampoco entra');
  await c.query('UPDATE tenants SET active = true WHERE id = $1', [O.id]);

  // ── Freno de login por usuario (IP propia para no tocar el freno por IP de otros tests) ──
  const ip = '10.77.0.9';
  const em = 'freno' + Date.now() + '@test.local';
  const OH = authH((await login(O.email, 'password456')).body.token);
  r = await send(OH, 'POST', '/api/team', { name: 'Freno', email: em, role: 'seller' });
  const tempF = r.body.tempPassword;
  let blocked = null;
  for (let k = 1; k <= 9; k++) { const x = await login(em, 'mala' + k, ip); if (x.status === 429) { blocked = k; break; } }
  ok(blocked === 9, 'Tras 8 intentos fallidos, el 9.º → 429 (freno por usuario; bloqueado en el intento ' + blocked + ')');
  r = await login(em, tempF, '10.77.0.10');
  ok(r.status === 429, 'Bloqueado incluso con la clave correcta (desde otra IP)');
  const o = await login(O.email, 'password456', '10.77.0.11');
  ok(o.status === 200, 'Otro usuario (el dueño) no queda bloqueado');

  await c.end();
});
