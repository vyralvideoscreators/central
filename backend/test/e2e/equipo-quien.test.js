// Fase 4B — quién hizo qué: pedidos, pagos, anulaciones, gastos, caja, existencias e historial muestran a la persona.
const { ok, run } = require('../helpers/harness');
const { setPlan, makeUser, j, send, reg, db } = require('../helpers/equipo');

run(async () => {
  const c = await db();
  const O = await reg('Quien');
  await setPlan(c, O.id, 'business');
  const seller = await makeUser(O, 'seller', 'Vera Vendedora');
  const manager = await makeUser(O, 'manager', 'Marcos Encargado');
  const ownerName = (await j('/api/team', { headers: O.H })).body.users[0].name;

  let r = await send(O.H, 'POST', '/api/catalog', { name: 'Taza', price: 10, cost: 3, trackStock: true });
  const prod = r.body;
  r = await send(seller.H, 'POST', '/api/orders', { clientName: 'C1', items: [{ productId: prod.id, name: 'Taza', qty: 1, unitPrice: 10 }] });
  ok(r.status === 200 && r.body.byName === 'Vera Vendedora' && r.body.createdByUserId === seller.id, 'El pedido muestra quién lo creó');
  const oid = r.body.id;
  r = await j('/api/orders', { headers: O.H });
  ok(r.body.find(o => o.id === oid).byName === 'Vera Vendedora', 'La lista de pedidos trae byName');
  r = await send(O.H, 'POST', '/api/orders', { clientName: 'C2', items: [{ name: 'X', qty: 1, unitPrice: 5 }] });
  ok(r.body.byName === ownerName, 'Un pedido del dueño muestra su nombre');
  r = await send(manager.H, 'PATCH', '/api/orders/' + oid, { notes: 'nota' });
  ok(r.status === 200, 'Encargado edita');
  r = await send(seller.H, 'POST', '/api/orders/' + oid + '/payments', { amount: 4, method: 'Efectivo' });
  ok(r.body.payment.byName === 'Vera Vendedora' && r.body.payment.voidedByName === null, 'El pago muestra quién lo registró');
  const pid = r.body.payment.id;
  r = await send(manager.H, 'POST', '/api/payments/' + pid + '/void', { reason: 'error' });
  ok(r.body.payment.voidedByName === 'Marcos Encargado' && r.body.payment.byName === 'Vera Vendedora', 'La anulación muestra quién anuló');
  r = await j('/api/payments?period=month', { headers: manager.H });
  const p = r.body.payments.find(x => x.id === pid);
  ok(p && p.byName === 'Vera Vendedora' && p.voidedByName === 'Marcos Encargado', 'La lista de Pagos trae byName y voidedByName');
  r = await j('/api/orders/' + oid + '/events', { headers: O.H });
  const by = Object.fromEntries(r.body.events.map(e => [e.type, e.byName]));
  ok(by.created === 'Vera Vendedora' && by.edited === 'Marcos Encargado' && by.payment_added === 'Vera Vendedora' && by.payment_voided === 'Marcos Encargado',
    'El historial del pedido dice quién hizo cada cosa (' + JSON.stringify(by) + ')');
  r = await send(manager.H, 'POST', '/api/orders/' + oid + '/cancel', { reason: 'prueba' });
  ok(r.status === 200, 'Anular pedido');
  r = await j('/api/orders/' + oid + '/events', { headers: O.H });
  ok(r.body.events.find(e => e.type === 'cancelled').byName === 'Marcos Encargado', 'La anulación del pedido queda a nombre del encargado');
  // Existencias
  r = await send(manager.H, 'POST', '/api/stock/adjust', { productId: prod.id, delta: 5, note: 'compra' });
  ok(r.status === 200 && r.body.movement.byName === 'Marcos Encargado', 'El ajuste de existencias muestra quién lo hizo');
  r = await j('/api/stock/movements', { headers: O.H });
  ok(r.body.movements.some(m => m.reason === 'sale' && m.byName === 'Vera Vendedora') && r.body.movements.some(m => m.byName === 'Marcos Encargado'), 'Los movimientos de existencias traen byName');
  // Gastos
  r = await send(manager.H, 'POST', '/api/expenses', { amount: 5, category: 'Otros', method: 'Efectivo', note: 'x' });
  ok(r.status === 200 && r.body.expense.byName === 'Marcos Encargado' && r.body.expense.voidedByName === null, 'El gasto muestra quién lo registró');
  const eid = r.body.expense.id;
  r = await send(O.H, 'POST', '/api/expenses/' + eid + '/void', { reason: 'dup' });
  ok(r.body.expense.voidedByName === ownerName, 'El gasto anulado muestra quién lo anuló');
  r = await j('/api/expenses?period=month', { headers: O.H });
  ok(r.body.expenses.find(e => e.id === eid).byName === 'Marcos Encargado', 'La lista de gastos trae byName');
  // Caja
  const today = new Date().toISOString().slice(0, 10);
  r = await j('/api/cash/' + today, { headers: manager.H });
  const counted = r.body.rows.map(x => ({ method: x.method, currency: x.currency, amount: x.expected }));
  r = await send(manager.H, 'POST', '/api/cash/' + today + '/close', { counted });
  ok(r.status === 200 && r.body.closing && r.body.closing.byName === 'Marcos Encargado', 'El cierre de caja muestra quién cerró (' + (r.body.error || '') + ')');
  r = await send(O.H, 'POST', '/api/cash/' + today + '/reopen', { reason: 'corregir' });
  ok(r.status === 200 && r.body.history[0].reopenedByName === ownerName && r.body.history[0].byName === 'Marcos Encargado', 'La reapertura muestra quién reabrió');
  // Lo antiguo (sin usuario) se muestra como «Dueño»
  await c.query('UPDATE orders SET created_by_user_id = NULL WHERE id = $1', [oid]);
  await c.query('UPDATE order_events SET created_by_user_id = NULL WHERE order_id = $1', [oid]);
  r = await j('/api/orders', { headers: O.H });
  ok(r.body.find(o => o.id === oid).byName === 'Dueño', 'Lo anterior a la Fase 4B (sin usuario) se muestra como «Dueño»');
  r = await j('/api/orders/' + oid + '/events', { headers: O.H });
  ok(r.body.events.every(e => e.byName === 'Dueño'), 'Y en el historial también');
  // Aislamiento del nombre: un id de otro negocio no se resuelve
  const B = await reg('Quien B');
  await c.query('UPDATE orders SET created_by_user_id = $1 WHERE id = $2', [(await c.query("SELECT id FROM team_users WHERE tenant_id=$1 AND role='owner'", [B.id])).rows[0].id, oid]);
  r = await j('/api/orders', { headers: O.H });
  ok(r.body.find(o => o.id === oid).byName === 'Dueño', 'El nombre de un usuario de otro negocio nunca se revela');
  await c.end();
});
