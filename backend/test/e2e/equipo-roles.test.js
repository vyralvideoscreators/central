// Fase 4B — matriz de roles × rutas. Saca TODAS las rutas con requireAuth de server.js: si hay una sin clasificar en
// ROUTE_MIN_ROLE (o una clasificada que ya no existe) la prueba falla. Luego recorre cada ruta con un vendedor y un encargado.
const fs = require('fs');
const path = require('path');
const { ok, run } = require('../helpers/harness');
const { setPlan, makeUser, j, send, reg, db } = require('../helpers/equipo');
const team = require('../../equipo');

const NIL = '00000000-0000-4000-8000-000000000000';
const fill = (p) => p.replace(':id', NIL).replace(':waId', '584000000000').replace(':day', '2026-01-01').replace(':mediaId', 'x');

run(async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8');
  const routes = [...src.matchAll(/^app\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*requireAuth\b/gm)].map(m => m[1].toUpperCase() + ' ' + m[2]);
  ok(routes.length >= 60, 'Se encontraron ' + routes.length + ' rutas con requireAuth en server.js');
  const classified = Object.keys(team.ROUTE_MIN_ROLE);
  const missing = routes.filter(k => !team.ROUTE_MIN_ROLE[k]);
  ok(missing.length === 0, 'Todas las rutas con requireAuth están clasificadas por rol' + (missing.length ? ' — SIN CLASIFICAR: ' + missing.join(', ') : ''));
  const stale = classified.filter(k => !routes.includes(k));
  ok(stale.length === 0, 'No hay rutas clasificadas que ya no existan' + (stale.length ? ' — SOBRAN: ' + stale.join(', ') : ''));
  ok(classified.every(k => ['seller', 'manager', 'owner'].includes(team.ROUTE_MIN_ROLE[k])), 'Todos los roles mínimos son válidos');

  const c = await db();
  const O = await reg('Roles');
  await setPlan(c, O.id, 'business');
  const seller = await makeUser(O, 'seller', 'Vera Vendedora');
  const manager = await makeUser(O, 'manager', 'Marcos Encargado');

  // ── Recorrido completo ──
  const bad = [];
  for (const [who, U] of [['seller', seller], ['manager', manager]]) {
    for (const key of routes) {
      const [method, p] = key.split(' ');
      const min = team.ROUTE_MIN_ROLE[key];
      const allowed = team.roleAtLeast(who, min);
      const r = await j(fill(p), { method, headers: U.H, body: method === 'GET' ? undefined : JSON.stringify({}) });
      const forbidden = r.status === 403 && r.body && r.body.error === 'role_forbidden';
      if (allowed && (forbidden || r.status === 401 || r.status === 500 || (r.status === 403 && r.body && ['must_change_password', 'demo_blocked'].includes(r.body.error)))) {
        bad.push(`${who} debería poder ${key} y dio ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
      }
      if (!allowed && !forbidden) bad.push(`${who} NO debería poder ${key} y dio ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
    }
  }
  ok(bad.length === 0, `Matriz roles × rutas (${routes.length} rutas × 2 roles)` + (bad.length ? ':\n  ' + bad.join('\n  ') : ''));

  // ── Reglas explícitas del encargo ──
  const sellerForbidden = ['POST /api/payments/:id/void', 'POST /api/orders/:id/cancel', 'POST /api/orders/:id/returns', 'POST /api/catalog',
    'PATCH /api/catalog/:id', 'DELETE /api/catalog/:id', 'POST /api/stock/adjust', 'GET /api/stock/movements', 'GET /api/expenses', 'POST /api/expenses',
    'GET /api/cash', 'POST /api/cash/:day/close', 'GET /api/reports', 'GET /api/reports/profit', 'GET /api/reports/receivables', 'PUT /api/tenant/profile',
    'PUT /api/tenant/settings', 'GET /api/tenant/auto-reply', 'PUT /api/tenant/auto-reply', 'GET /api/team', 'GET /api/billing/status',
    'POST /api/billing/portal', 'PUT /api/tenant/whatsapp', 'DELETE /api/clients/:id'];
  ok(sellerForbidden.every(k => !team.roleAtLeast('seller', team.ROUTE_MIN_ROLE[k])), 'Vendedor: lo que el encargo le prohíbe está en la matriz');
  const sellerAllowed = ['GET /api/conversations', 'POST /api/send', 'GET /api/clients', 'POST /api/clients', 'PATCH /api/clients/:id', 'POST /api/orders',
    'PATCH /api/orders/:id', 'POST /api/orders/:id/convert', 'POST /api/orders/:id/payments', 'GET /api/catalog', 'POST /api/send-ticket'];
  ok(sellerAllowed.every(k => team.roleAtLeast('seller', team.ROUTE_MIN_ROLE[k])), 'Vendedor: lo que el encargo le permite está en la matriz');
  const managerForbidden = ['GET /api/team', 'POST /api/team', 'POST /api/billing/create-checkout', 'GET /api/billing/status', 'POST /api/billing/cancel',
    'PUT /api/tenant/whatsapp', 'POST /api/cash/:day/reopen'];
  ok(managerForbidden.every(k => !team.roleAtLeast('manager', team.ROUTE_MIN_ROLE[k])), 'Encargado: equipo, facturación, canales y reabrir caja son del dueño');
  ok(team.roleAtLeast('manager', team.ROUTE_MIN_ROLE['GET /api/reports']) && team.roleAtLeast('manager', team.ROUTE_MIN_ROLE['POST /api/orders/:id/cancel']), 'Encargado: informes y anulaciones sí');

  // ── Reglas finas dentro de las rutas ──
  let r = await send(manager.H, 'PUT', '/api/tenant/profile', { email: 'otro' + Date.now() + '@test.local', currentPassword: 'x' });
  ok(r.status === 403 && r.body.error === 'role_forbidden', 'Encargado: cambiar el correo de acceso → 403');
  r = await send(manager.H, 'PUT', '/api/tenant/profile', { business_name: 'Roles SA', email: O.email });
  ok(r.status === 200 && r.body.tenant.business_name === 'Roles SA', 'Encargado: editar el perfil (reenviando el mismo correo) → 200');
  r = await j('/api/tenant/profile', { headers: O.H });
  ok(r.body.email === O.email, 'El correo del dueño no cambió');
  r = await send(manager.H, 'PUT', '/api/tenant/settings', { baseCurrency: 'EUR' });
  ok(r.status === 403 && r.body.error === 'role_forbidden', 'Encargado: cambiar la moneda base → 403');
  r = await send(manager.H, 'PUT', '/api/tenant/settings', { baseCurrency: 'USD', tax: { enabled: false, rate: 0, label: 'IVA' } });
  ok(r.status === 200, 'Encargado: guardar ajustes con la misma moneda base → 200');
  r = await send(O.H, 'PUT', '/api/tenant/settings', { baseCurrency: 'EUR' });
  ok(r.status === 200 && r.body.baseCurrency === 'EUR', 'El dueño sí cambia la moneda base');
  await send(O.H, 'PUT', '/api/tenant/settings', { baseCurrency: 'USD' });
  r = await send(manager.H, 'POST', '/api/cash/2026-01-01/reopen', { reason: 'x' });
  ok(r.status === 403 && r.body.error === 'role_forbidden', 'Encargado: reabrir caja → 403');

  // ── El vendedor no recibe costos ──
  r = await send(O.H, 'POST', '/api/catalog', { name: 'Camisa', price: 20, cost: 7.5, sizes: ['M'] });
  const prod = r.body;
  ok(r.status === 200 && prod.cost === 7.5, 'El dueño crea un producto con costo');
  r = await j('/api/catalog', { headers: seller.H });
  ok(r.status === 200 && r.body.length === 1 && r.body[0].name === 'Camisa' && !('cost' in r.body[0]) && !JSON.stringify(r.body).includes('"cost"'), 'Vendedor: el catálogo NO trae costo');
  r = await j('/api/catalog', { headers: manager.H });
  ok(r.body[0].cost === 7.5, 'Encargado: el catálogo trae el costo');
  r = await j('/api/stock?productId=' + prod.id, { headers: seller.H });
  ok(r.status === 200 && !('cost' in r.body) && Array.isArray(r.body.variants), 'Vendedor: existencias de un producto sin costo');
  r = await j('/api/stock?productId=' + prod.id, { headers: manager.H });
  ok(r.body.cost === 7.5, 'Encargado: existencias con costo');
  r = await send(seller.H, 'POST', '/api/orders', { clientName: 'Cliente V', items: [{ productId: prod.id, name: 'Camisa', qty: 2, unitPrice: 20, emoji: '👕' }] });
  ok(r.status === 200 && r.body.totalPrice == 40, 'Vendedor: crea un pedido con un producto del catálogo');
  const orderId = r.body.id;
  ok(!/unit_?cost|"cost"|margin/i.test(JSON.stringify(r.body)), 'La respuesta del pedido no incluye costos ni márgenes');
  r = await j('/api/orders', { headers: seller.H });
  ok(!/unit_?cost|"cost"|margin/i.test(JSON.stringify(r.body)), 'La lista de pedidos no incluye costos ni márgenes');
  r = await j('/api/orders/' + orderId + '/events', { headers: seller.H });
  ok(r.status === 200 && !/unit_?cost|"cost"|margin/i.test(JSON.stringify(r.body)), 'El historial del pedido no incluye costos');

  // ── Lo que el vendedor SÍ hace de punta a punta ──
  r = await send(seller.H, 'POST', '/api/clients', { name: 'Cliente Nuevo', phone: '+58412000111' });
  ok(r.status === 200, 'Vendedor: crea un cliente');
  const clientId = r.body.id;
  r = await send(seller.H, 'PATCH', '/api/clients/' + clientId, { name: 'Cliente Editado' });
  ok(r.status === 200, 'Vendedor: edita un cliente');
  r = await send(seller.H, 'DELETE', '/api/clients/' + clientId);
  ok(r.status === 403, 'Vendedor: NO borra clientes');
  r = await send(seller.H, 'POST', '/api/orders/' + orderId + '/payments', { amount: 10, method: 'Efectivo' });
  ok(r.status === 200 && r.body.payment, 'Vendedor: registra un pago');
  const payId = r.body.payment.id;
  r = await send(seller.H, 'POST', '/api/payments/' + payId + '/void', { reason: 'error' });
  ok(r.status === 403 && r.body.error === 'role_forbidden', 'Vendedor: NO anula pagos');
  r = await send(manager.H, 'POST', '/api/payments/' + payId + '/void', { reason: 'error de captura' });
  ok(r.status === 200, 'Encargado: anula el pago');
  r = await send(seller.H, 'POST', '/api/orders/' + orderId + '/cancel', { reason: 'x' });
  ok(r.status === 403, 'Vendedor: NO anula pedidos');
  r = await send(seller.H, 'POST', '/api/orders', { kind: 'quote', clientName: 'Cliente Q', items: [{ productId: prod.id, name: 'Camisa', qty: 1, unitPrice: 20 }] });
  ok(r.status === 200 && r.body.kind === 'quote', 'Vendedor: crea un presupuesto');
  r = await send(seller.H, 'POST', '/api/orders/' + r.body.id + '/convert', {});
  ok(r.status === 200 && r.body.order.kind === 'order', 'Vendedor: convierte el presupuesto');
  r = await send(seller.H, 'PATCH', '/api/orders/' + orderId, { delivery_status: 'preparing' });
  ok(r.status === 200, 'Vendedor: cambia el estado del pedido');
  r = await send(seller.H, 'POST', '/api/stock/adjust', { productId: prod.id, delta: 5 });
  ok(r.status === 403, 'Vendedor: NO ajusta existencias');
  r = await j('/api/expenses', { headers: seller.H });
  ok(r.status === 403, 'Vendedor: NO ve gastos');
  r = await j('/api/cash-closed', { headers: seller.H });
  ok(r.status === 200 && r.body.days && !('expected' in r.body), 'Vendedor: ve solo qué días están cerrados (sin importes)');
  r = await j('/api/payments?period=month', { headers: seller.H });
  ok(r.status === 200, 'Vendedor: ve la lista de cobros');

  // El plan básico sigue mandando sobre el rol (un encargado en Básico no ve informes)
  await setPlan(c, O.id, 'basic');
  r = await j('/api/reports?period=mes', { headers: manager.H });
  ok(r.status === 403 && r.body.error === 'plan_required', 'Encargado en plan Básico: informes → 403 plan_required (el plan sigue mandando)');
  await c.end();
});
