// Fase 4B (corrección tras la revisión) — el vendedor no toca precios, tokens del equipo sin tenantId, demos con correo inventado y
// barrido de su equipo, tope de altas por hora, 503 sin base, contadores solo con counts=1.
const jwt = require('jsonwebtoken');
const { ok, run, adminToken, DEMO_KEY } = require('../helpers/harness');
const { login, authH, setPlan, makeUser, j, send, reg, db } = require('../helpers/equipo');

const MSG = 'Tu rol no permite cambiar precios, descuentos ni el envío';

run(async () => {
  const c = await db();
  const O = await reg('Correcciones');
  await setPlan(c, O.id, 'business');
  const seller = await makeUser(O, 'seller', 'Vera Vendedora');
  const manager = await makeUser(O, 'manager', 'Marcos Encargado');

  // ── Tokens ──
  const dec = jwt.decode(seller.token);
  ok(dec.tenantId === undefined && dec.tid === O.id && dec.userId === seller.id, 'El token del vendedor lleva tid y NO tenantId (el servidor 4A lo rechazaría con 401)');
  const decM = jwt.decode(manager.token);
  ok(decM.tenantId === undefined && decM.tid === O.id, 'Igual el del encargado');
  const ownerTok = jwt.decode((await login(O.email, 'password123')).body.token);
  ok(ownerTok.tenantId === O.id && ownerTok.tid === O.id, 'El del dueño conserva tenantId (sus sesiones siguen valiendo en la 4A)');
  let r = await j('/api/orders', { headers: seller.H });
  ok(r.status === 200, 'El servidor nuevo acepta el token con tid');

  // ── El vendedor NO toca precios ──
  r = await send(O.H, 'POST', '/api/catalog', { name: 'Camisa', price: 20, cost: 7, sizes: ['M'] });
  const prod = r.body;
  r = await send(O.H, 'PUT', '/api/tenant/settings', { zones: [{ name: 'Norte', cost: 3 }, { name: 'Sur' }] });
  ok(r.status === 200, 'El dueño configura la zona Norte con envío 3');
  const line = (extra = {}) => ({ productId: prod.id, name: 'Camisa', qty: 2, unitPrice: 20, ...extra });

  r = await send(seller.H, 'POST', '/api/orders', { clientName: 'Cliente A', items: [line({ unitPrice: 1 })] });
  ok(r.status === 200 && r.body.totalPrice == 40 && r.body.items[0].unitPrice == 20 && r.body.items[0].linePrice == 40,
    'Vendedor: el precio que envíe se ignora, vale el del catálogo (total 40)');
  const orderA = r.body.id;
  r = await send(seller.H, 'POST', '/api/orders', { clientName: 'Cliente A', items: [{ name: 'Libre', qty: 1, unitPrice: 5 }] });
  ok(r.status === 403 && r.body.error === 'role_forbidden', 'Vendedor: una línea libre (sin producto) → 403 role_forbidden');
  r = await send(seller.H, 'POST', '/api/orders', { clientName: 'Cliente A', items: [line()], discount: 5 });
  ok(r.status === 403 && r.body.error === 'role_forbidden' && r.body.message === MSG, 'Vendedor: descuento → 403 con el mensaje de la decisión');
  r = await send(seller.H, 'POST', '/api/orders', { clientName: 'Cliente A', items: [line()], shipping: 9 });
  ok(r.status === 403 && r.body.error === 'role_forbidden', 'Vendedor: envío manual → 403');
  r = await send(seller.H, 'POST', '/api/orders', { clientName: 'Cliente A', items: [line()], shipping: 3, deliveryZone: 'Norte' });
  ok(r.status === 200 && r.body.totalPrice == 43 && r.body.shipping == 3, 'Vendedor: el envío de la zona con costo sí (total 43)');
  r = await send(seller.H, 'POST', '/api/orders', { clientName: 'Cliente A', items: [line()], shipping: 4, deliveryZone: 'Norte' });
  ok(r.status === 403, 'Vendedor: la zona Norte cuesta 3, no 4 → 403');
  r = await send(seller.H, 'POST', '/api/orders', { clientName: 'Cliente A', items: [line()], shipping: 3, deliveryZone: 'Sur' });
  ok(r.status === 403, 'Vendedor: la zona Sur no tiene costo configurado → 403');
  r = await send(seller.H, 'POST', '/api/orders', { clientName: 'Cliente A', totalPrice: 99 });
  ok(r.status === 403, 'Vendedor: un total manual sin artículos → 403');
  r = await send(seller.H, 'POST', '/api/orders', { clientName: 'Cliente B', items: [line({ qty: 1 })], initialPayment: { amount: 5, method: 'Efectivo' } });
  ok(r.status === 200 && r.body.amountPaid == 5, 'Vendedor: el cobro inicial sí');

  // Edición
  r = await send(seller.H, 'PATCH', '/api/orders/' + orderA, { items: [line({ qty: 3, unitPrice: 0.5 })], notes: 'Tocar el timbre', address: 'Calle 1' });
  ok(r.status === 200 && r.body.totalPrice == 60 && r.body.items[0].unitPrice == 20 && r.body.notes === 'Tocar el timbre', 'Vendedor: edita cantidades y notas; el precio sigue siendo el del catálogo (total 60)');
  r = await send(seller.H, 'PATCH', '/api/orders/' + orderA, { discount: 5 });
  ok(r.status === 403 && r.body.message === MSG, 'Vendedor: PATCH con descuento → 403');
  r = await send(seller.H, 'PATCH', '/api/orders/' + orderA, { shipping: 9 });
  ok(r.status === 403, 'Vendedor: PATCH con envío distinto → 403');
  r = await send(seller.H, 'PATCH', '/api/orders/' + orderA, { discount: 0, shipping: 0, total_price: 60, delivery_status: 'preparing' });
  ok(r.status === 200 && r.body.deliveryStatus === 'preparing', 'Vendedor: reenviar los mismos importes y cambiar el estado sí');
  r = await send(seller.H, 'PATCH', '/api/orders/' + orderA, { delivery_zone: 'Norte', shipping: 3 });
  ok(r.status === 200 && r.body.totalPrice == 63, 'Vendedor: poner la zona Norte con su envío (63)');
  r = await send(seller.H, 'PATCH', '/api/orders/' + orderA, { items: [{ name: 'Libre', qty: 1, unitPrice: 1 }] });
  ok(r.status === 403, 'Vendedor: PATCH con una línea libre → 403');
  // Pedido sin artículos (antiguo): el total no se toca
  const { rows: [legacy] } = await c.query(`INSERT INTO orders (tenant_id, client_name, total_price, kind, delivery_status, pay_status) VALUES ($1, 'Antiguo', 50, 'order', 'to_deliver', 'pend') RETURNING id`, [O.id]);
  r = await send(seller.H, 'PATCH', '/api/orders/' + legacy.id, { total_price: 10 });
  ok(r.status === 403, 'Vendedor: no cambia el total de un pedido sin artículos');
  r = await send(manager.H, 'PATCH', '/api/orders/' + legacy.id, { total_price: 10 });
  ok(r.status === 200 && r.body.totalPrice == 10, 'Encargado: sí');
  // Una línea con precio fijado por el encargado se conserva si el vendedor la reenvía igual
  r = await send(manager.H, 'POST', '/api/orders', { clientName: 'Cliente C', items: [line({ unitPrice: 15, qty: 1 })], discount: 2 });
  ok(r.status === 200 && r.body.totalPrice == 13 && r.body.items[0].unitPrice == 15, 'Encargado: fija un precio de línea y un descuento');
  const orderC = r.body.id;
  r = await send(seller.H, 'PATCH', '/api/orders/' + orderC, { items: [line({ unitPrice: 15, qty: 2 })] });
  ok(r.status === 200 && r.body.items[0].unitPrice == 15 && r.body.totalPrice == 28, 'Vendedor: editar la cantidad de una línea ya guardada no la re-tasa (28 con el descuento)');
  r = await send(seller.H, 'PATCH', '/api/orders/' + orderC, { items: [line({ unitPrice: 1, qty: 2 })] });
  ok(r.status === 200 && r.body.items[0].unitPrice == 20, 'y un precio distinto que envíe se ignora: vale el del catálogo (20)');
  r = await send(O.H, 'POST', '/api/orders', { clientName: 'Cliente D', items: [{ name: 'Servicio libre', qty: 1, unitPrice: 7 }], discount: 1 });
  ok(r.status === 200 && r.body.totalPrice == 6, 'El dueño sí usa líneas libres y descuentos');

  // ── Altas del equipo: 20 por hora y negocio ──
  const T = await reg('Tope altas');
  await setPlan(c, T.id, 'business');
  let created = 0, last = null;
  for (let k = 0; k < 24; k++) {
    last = await send(T.H, 'POST', '/api/team', { name: 'U' + k, email: 'tope' + k + Date.now() + '@test.local', role: 'seller' });
    if (last.status !== 200) break;
    created++;
    await send(T.H, 'PATCH', '/api/team/' + last.body.user.id, { active: false });
  }
  ok(created === 20 && last.status === 429 && last.body.error === 'rate_limited', 'A la altas número 21 en una hora → 429 rate_limited (' + created + ' creadas)');

  // ── Demos: correo inventado y barrido del equipo al revocar ──
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await adminToken(), 'X-Demo-Key': DEMO_KEY };
  const demoMail = 'democorr' + Date.now() + '@test.local';
  r = await send(AH, 'POST', '/api/admin/demos', { email: demoMail, businessName: 'Demo Correcciones', days: 3, sendEmail: false });
  const demo = r.body;
  const D = authH((await login(demoMail, demo.password)).body.token);
  r = await send(D, 'POST', '/api/team', { name: 'Real', email: 'persona.real@gmail.com', role: 'seller' });
  ok(r.status === 400 && /demo\.central\.test/.test(r.body.error || r.body.message || ''), 'Demo: un correo real se rechaza (400) con un mensaje claro');
  r = await send(D, 'POST', '/api/team', { name: 'Ficticio', email: 'ventas' + Date.now() + '@demo.central.test', role: 'seller' });
  ok(r.status === 200, 'Demo: un correo @demo.central.test sí');
  const nTeam = async () => (await c.query("SELECT count(*)::int AS n FROM team_users WHERE tenant_id = $1 AND role <> 'owner'", [demo.tenantId])).rows[0].n;
  ok(await nTeam() === 3, 'La demo tiene 3 usuarios además del dueño');
  await c.query("UPDATE tenants SET expires_at = now() - interval '1 minute' WHERE id = $1", [demo.tenantId]); // caducó sola
  // el barrido horario corre al arrancar; aquí se provoca con la revocación (misma función)
  await send(AH, 'POST', '/api/admin/demos/' + demo.tenantId + '/revoke', {});
  ok(await nTeam() === 0, 'Al caducar o revocar la demo, sus usuarios que no son el dueño se borran');
  const own = (await c.query("SELECT count(*)::int AS n FROM team_users WHERE tenant_id = $1 AND role = 'owner'", [demo.tenantId])).rows[0].n;
  ok(own === 1, 'El dueño de la demo se conserva');

  // ── «Nueva clave» no reactiva usuarios ni cambia su rol ──
  r = await send(AH, 'POST', '/api/admin/demos', { email: 'democ2' + Date.now() + '@test.local', businessName: 'Demo Nueva Clave', days: 3, sendEmail: false });
  const d2 = r.body;
  const mgr = d2.teamUsers.find(u => u.role === 'manager');
  await c.query("UPDATE team_users SET active = false, role = 'seller' WHERE id = $1", [mgr.id]);
  r = await send(AH, 'POST', '/api/admin/demos/' + d2.tenantId + '/resend', {});
  const again = r.body.teamUsers.find(u => u.id === mgr.id);
  ok(r.status === 200 && again && again.role === 'seller' && again.active === false, '«Nueva clave» devuelve el rol real y no reactiva al usuario desactivado');
  const row = (await c.query('SELECT role, active FROM team_users WHERE id = $1', [mgr.id])).rows[0];
  ok(row.role === 'seller' && row.active === false, 'y en la base sigue desactivado y con su rol');

  // ── Sin base de datos listos: 503 (no se deja pasar sin validar) se prueba en revision-4a; aquí, errores sin detalles ──
  r = await j('/api/tenant/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co', password: 'x' }) });
  ok(!('details' in (r.body || {})), 'Los errores de login no incluyen details');

  await c.end();
});
