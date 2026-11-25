// Fase 3 (2/2): devoluciones, notas de crédito, reembolsos, saldo a favor, informes, aislamiento y demos.
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, run, DEMO_KEY, adminToken, metaCalls } = require('../helpers/harness');
const post = (H, u, b) => send(H, 'POST', u, b);
const patch = (H, u, b) => send(H, 'PATCH', u, b);
const put = (H, u, b) => send(H, 'PUT', u, b);
const TZ = 'America/Caracas';

run(async () => {
  const db = await dbConnect();
  const A = await reg('Dev A'), Bt = await reg('Dev B');
  await db.query('UPDATE tenants SET timezone=$1, plan=$2 WHERE id=$3', [TZ, 'pro', A.id]);
  const get = (H, u) => j(u, { headers: H });
  const pay = (H, id, b) => post(H, `/api/orders/${id}/payments`, b);
  const ret = (H, id, b) => post(H, `/api/orders/${id}/returns`, b);
  const two = (H, extra = {}) => post(H, '/api/orders', { clientName: 'Cliente Dos', items: [{ name: 'Camisa', qty: 2, unitPrice: 30 }, { name: 'Gorra', qty: 1, unitPrice: 40 }], ...extra }).then(r => r.body);
  const one = (H, total, extra = {}) => post(H, '/api/orders', { clientName: 'Cliente Uno', items: [{ name: 'Art', qty: 1, unitPrice: total }], ...extra }).then(r => r.body);
  const creditOf = async (H, clientId) => (await get(H, `/api/clients/${clientId}/credit`)).body;

  // ── Devolución parcial por artículos con reembolso ──
  const o1 = await two(A.H);
  ok(Number(o1.totalPrice) === 100, 'Pedido de 100 (2 camisas de 30 + 1 gorra de 40)');
  const camisa = o1.items.find(i => i.name === 'Camisa'), gorra = o1.items.find(i => i.name === 'Gorra');
  await pay(A.H, o1.id, { full: true, method: 'Efectivo' });
  let r = await ret(A.H, o1.id, { items: [{ orderItemId: camisa.id, qty: 1 }], reason: 'Talla equivocada', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200 && r.body.creditNote.number === 'NC-0001' && r.body.creditNote.amountBase === 30, 'Nota de crédito NC-0001 de 30');
  ok(r.body.order.creditedTotal === 30 && r.body.order.effectiveTotal === 70 && r.body.order.amountPaid === 70 && r.body.order.balance === 0 && r.body.order.payStatus === 'ok',
    'Total efectivo 70, cobrado neto 70, saldo 0, sigue pagado');
  ok(r.body.creditNote.items.length === 1 && r.body.creditNote.items[0].qty === 1 && r.body.creditNote.refunds.length === 1 && r.body.creditNote.refunds[0].amountBase === 30,
    'La nota trae su artículo y su reembolso de 30 en efectivo');
  ok(Number(r.body.order.totalPrice) === 100, 'totalPrice no cambia (el dinero no se edita)');
  r = await ret(A.H, o1.id, { items: [{ orderItemId: camisa.id, qty: 2 }], reason: 'x', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400 && /ya se devolvieron 1/.test(r.body.error), 'Más unidades de las vendidas menos las devueltas → 400');
  r = await ret(A.H, o1.id, { items: [{ orderItemId: camisa.id, qty: 1 }, { orderItemId: camisa.id, qty: 1 }], reason: 'x', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400, 'La misma línea repetida se suma: 2 > 1 disponible → 400');
  r = await ret(A.H, o1.id, { items: [{ orderItemId: camisa.id, qty: 1 }], reason: 'Otra', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200 && r.body.creditNote.number === 'NC-0002' && r.body.order.effectiveTotal === 40, 'Segunda nota NC-0002; total efectivo 40');
  r = await ret(A.H, o1.id, { items: [{ orderItemId: camisa.id, qty: 1 }], reason: 'x', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400, 'Ya no quedan camisas por devolver → 400');
  r = await ret(A.H, o1.id, { items: [{ orderItemId: gorra.id, qty: 0 }], reason: 'x', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400, 'Cantidad 0 → 400');
  r = await ret(A.H, o1.id, { items: [{ orderItemId: gorra.id, qty: 1.5 }], reason: 'x', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400, 'Cantidad con decimales → 400');
  const lst = (await get(A.H, `/api/orders/${o1.id}/returns`)).body;
  ok(lst.creditNotes.length === 2 && lst.creditNotes[0].number === 'NC-0001' && lst.refunds.length === 2, 'GET devoluciones: 2 notas y 2 reembolsos');
  ok((await get(A.H, `/api/orders/${o1.id}/events`)).body.events.filter(e => e.type === 'returned').length === 2, 'Historial: 2 eventos returned');
  r = await patch(A.H, `/api/orders/${o1.id}`, { items: [{ name: 'Otra', qty: 1, unitPrice: 5 }] });
  ok(r.status === 400, 'Con devoluciones no se pueden cambiar los artículos');
  r = await patch(A.H, `/api/orders/${o1.id}`, { notes: 'sigue editable' });
  ok(r.status === 200, 'Pero sí otros datos');

  // ── Validaciones de la devolución ──
  const o2 = await one(A.H, 100, { clientName: 'Carla Crédito' });
  await pay(A.H, o2.id, { full: true, method: 'Zelle' });
  const base = { reason: 'Prueba', resolution: 'refund', refundMethod: 'Zelle' };
  for (const [msg, body] of [
    ['sin artículos ni importe', { ...base }],
    ['con artículos e importe a la vez', { ...base, amount: 5, items: [{ orderItemId: o2.items[0].id, qty: 1 }] }],
    ['importe 0', { ...base, amount: 0 }], ['importe negativo', { ...base, amount: -5 }], ['importe texto', { ...base, amount: 'abc' }],
    ['importe mayor que el pedido', { ...base, amount: 100.01 }],
    ['sin motivo', { resolution: 'refund', refundMethod: 'Zelle', amount: 5 }],
    ['sin resolución', { reason: 'x', amount: 5 }], ['resolución inventada', { reason: 'x', amount: 5, resolution: 'regalo' }],
    ['reembolso sin método', { reason: 'x', amount: 5, resolution: 'refund' }],
    ['método «Saldo a favor» como reembolso', { reason: 'x', amount: 5, resolution: 'refund', refundMethod: 'saldo a favor' }],
    ['artículo inexistente', { ...base, items: [{ orderItemId: '00000000-0000-4000-8000-000000000000', qty: 1 }] }],
    ['artículo no UUID', { ...base, items: [{ orderItemId: 'abc', qty: 1 }] }],
    ['artículos vacíos', { ...base, items: [] }],
  ]) {
    r = await ret(A.H, o2.id, body);
    ok(r.status === 400, 'Devolución inválida (' + msg + ') → 400');
  }
  ok((await get(A.H, `/api/orders/${o2.id}/returns`)).body.creditNotes.length === 0, 'Ninguna devolución inválida dejó rastro');
  r = await post(A.H, '/api/orders/no-es-uuid/returns', { ...base, amount: 5 });
  ok(r.status === 404, 'Id que no es UUID → 404');

  // ── Por importe + saldo a favor ──
  r = await ret(A.H, o2.id, { amount: 25, reason: 'Defecto menor', resolution: 'credit' });
  ok(r.status === 200 && r.body.creditNote.amountBase === 25 && r.body.creditNote.items[0].orderItemId === null, 'Devolución por importe de 25 como saldo a favor');
  ok(r.body.order.amountPaid === 75 && r.body.order.effectiveTotal === 75 && r.body.order.balance === 0, 'Cobrado neto 75 = total efectivo 75');
  let cr = await creditOf(A.H, o2.clientId);
  ok(cr.balance === 25 && cr.entries.length === 1 && cr.entries[0].kind === 'refund_to_credit' && /^#\d{4}$/.test(cr.entries[0].orderNumber), 'El cliente tiene 25 a favor');
  const ficha = (await get(A.H, '/api/clients')).body.find(c => c.id === o2.clientId);
  ok(ficha.credit === 25 && ficha.balance === 0, 'La ficha del cliente: credit 25, balance 0');
  r = await ret(A.H, o2.id, { amount: 75.01, reason: 'x', resolution: 'credit' });
  ok(r.status === 400, 'No se puede devolver más que el total efectivo (75)');

  // ── Pedido no cobrado del todo: la nota solo reduce lo que se debe ──
  const o3 = await one(A.H, 100);
  await pay(A.H, o3.id, { amount: 20, method: 'Efectivo' });
  r = await ret(A.H, o3.id, { amount: 30, reason: 'Ajuste', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200 && r.body.order.amountPaid === 20 && r.body.order.balance === 50 && r.body.order.payStatus === 'partial'
    && r.body.creditNote.refunds.length === 0, 'Cobrado 20 de 70: sin reembolso, saldo 50');
  // Cobrado 90 de 100, nota de 30 → exceso de 20 (no 30)
  const o4 = await one(A.H, 100);
  await pay(A.H, o4.id, { amount: 90, method: 'Efectivo' });
  r = await ret(A.H, o4.id, { amount: 30, reason: 'Ajuste', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200 && r.body.creditNote.refunds.length === 1 && r.body.creditNote.refunds[0].amountBase === 20
    && r.body.order.amountPaid === 70 && r.body.order.balance === 0 && r.body.order.payStatus === 'ok', 'Cobrado 90, nota de 30 → solo se reembolsan 20 (el exceso)');
  // Sin pagos: nada que reembolsar aunque se pida saldo a favor
  const o5 = await one(A.H, 50);
  r = await ret(A.H, o5.id, { amount: 10, reason: 'Ajuste', resolution: 'credit' });
  ok(r.status === 200 && r.body.order.effectiveTotal === 40 && r.body.order.balance === 40 && (await creditOf(A.H, o5.clientId)).balance === 0, 'Sin cobros: solo baja lo que debe (no regala saldo)');

  // ── Impuesto y descuento en la parte devuelta ──
  const TX = await reg('Dev Impuesto');
  await put(TX.H, '/api/tenant/settings', { tax: { enabled: true, rate: 10, label: 'IVA' } });
  const ot = await post(TX.H, '/api/orders', { clientName: 'Tomás Tax', discount: 10, items: [{ name: 'Lámpara', qty: 2, unitPrice: 50 }] }).then(x => x.body);
  ok(Number(ot.totalPrice) === 99 && ot.taxAmount === 9, 'Pedido con IVA 10 % y descuento 10: total 99');
  await pay(TX.H, ot.id, { full: true, method: 'Efectivo' });
  r = await ret(TX.H, ot.id, { items: [{ orderItemId: ot.items[0].id, qty: 1 }], reason: 'Rota', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200 && r.body.creditNote.amountBase === 49.5, 'Una lámpara devuelta = 50 − 5 de descuento + 4.50 de IVA = 49.50');
  r = await ret(TX.H, ot.id, { items: [{ orderItemId: ot.items[0].id, qty: 1 }], reason: 'Rota', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200 && r.body.creditNote.amountBase === 49.5 && r.body.order.effectiveTotal === 0 && r.body.order.amountPaid === 0, 'La segunda cierra en 99 exactos');

  // ── Pagar con saldo a favor ──
  const clientId = o2.clientId; // tiene 25 a favor
  const p1 = await one(A.H, 40, { clientId });
  r = await pay(A.H, p1.id, { amount: 30, method: 'saldo a favor' });
  ok(r.status === 400 && /25\.00/.test(r.body.error), 'Pagar con más saldo del que tiene → 400');
  r = await pay(A.H, p1.id, { amount: 25, method: 'Saldo a Favor', currency: 'VES', exchangeRate: 40 });
  ok(r.status === 400, 'El saldo a favor solo se usa en moneda base');
  r = await pay(A.H, p1.id, { amount: 25, method: 'Saldo a Favor' });
  ok(r.status === 200 && r.body.payment.method === 'Saldo a favor' && r.body.order.amountPaid === 25 && r.body.order.payStatus === 'partial', 'Pago de 25 con saldo a favor');
  cr = await creditOf(A.H, clientId);
  ok(cr.balance === 0 && cr.entries[0].kind === 'credit_payment' && cr.entries[0].amount === -25, 'El saldo baja a 0 con un movimiento negativo');
  r = await pay(A.H, p1.id, { amount: 1, method: 'Saldo a favor' });
  ok(r.status === 400, 'Sin saldo no se puede pagar con saldo');
  const payId = (await get(A.H, `/api/orders/${p1.id}/payments`)).body.payments[0].id;
  r = await post(A.H, `/api/payments/${payId}/void`, { reason: 'Error al elegir' });
  ok(r.status === 200 && r.body.order.amountPaid === 0 && r.body.order.payStatus === 'pend', 'Anular el pago con saldo');
  cr = await creditOf(A.H, clientId);
  ok(cr.balance === 25 && cr.entries[0].kind === 'credit_payment_void' && cr.entries[0].amount === 25, 'El saldo vuelve (movimiento credit_payment_void)');
  // sin cliente no hay saldo que usar
  const nc = await one(A.H, 20, { clientName: 'Sin cliente' });
  await patch(A.H, `/api/orders/${nc.id}`, { client_id: null });
  r = await pay(A.H, nc.id, { amount: 5, method: 'Saldo a favor' });
  ok(r.status === 400 && /cliente/i.test(r.body.error), 'Pedido sin cliente → no admite saldo a favor');
  // full: true con saldo suficiente
  const p2 = await one(A.H, 20, { clientId });
  r = await pay(A.H, p2.id, { full: true, method: 'Saldo a favor' });
  ok(r.status === 200 && r.body.order.payStatus === 'ok' && r.body.order.amountPaid === 20, 'Pago completo con saldo a favor');
  cr = await creditOf(A.H, clientId);
  ok(cr.balance === 5, 'Quedan 5 a favor');

  // ── Pagos con saldo a favor en paralelo: no se pasan ──
  const par = [];
  for (let i = 0; i < 4; i++) par.push(await one(A.H, 10, { clientId }));
  const rs = await Promise.all(par.map(o => pay(A.H, o.id, { amount: 4, method: 'Saldo a favor' })));
  ok(rs.filter(x => x.status === 200).length === 1 && rs.filter(x => x.status === 400).length === 3, 'Cuatro pagos de 4 con 5 de saldo, a la vez: solo uno entra');
  const sum = (await db.query('SELECT COALESCE(SUM(amount),0) s FROM client_credit_entries WHERE client_id=$1', [clientId])).rows[0].s;
  ok(Number(sum) === 1, 'El saldo queda en 1 (nunca negativo)');
  const same = await one(A.H, 10, { clientId });
  const rs2 = await Promise.all([1, 2, 3].map(() => pay(A.H, same.id, { amount: 1, method: 'Saldo a favor' })));
  ok(rs2.filter(x => x.status === 200).length === 1, 'Tres pagos de 1 sobre el mismo pedido con 1 de saldo: solo uno');
  const neg = (await db.query('SELECT client_id, SUM(amount) s FROM client_credit_entries GROUP BY client_id HAVING SUM(amount) < 0')).rows;
  ok(neg.length === 0, 'Ningún cliente quedó con saldo negativo');

  // ── Anular un pedido pagado con saldo a favor: el dinero vuelve al saldo, no sale como efectivo ──
  const sv = await one(A.H, 10, { clientId: o2.clientId });
  const cur = (await creditOf(A.H, o2.clientId)).balance;
  // dejamos 10 de saldo: devolvemos un importe de otro pedido
  const feed = await one(A.H, 30, { clientId: o2.clientId });
  await pay(A.H, feed.id, { full: true, method: 'Efectivo' });
  await ret(A.H, feed.id, { amount: 30, reason: 'Fondos', resolution: 'credit' });
  r = await pay(A.H, sv.id, { full: true, method: 'Saldo a favor' });
  ok(r.status === 200 && r.body.order.payStatus === 'ok', 'Pedido de 10 pagado con saldo a favor');
  r = await post(A.H, `/api/orders/${sv.id}/cancel`, { reason: 'Cancelado', resolution: 'refund', refundMethod: 'Efectivo' });
  const refs = (await get(A.H, `/api/orders/${sv.id}/returns`)).body.refunds;
  ok(r.status === 200 && refs.length === 1 && refs[0].method === 'Saldo a favor' && refs[0].amountBase === 10, 'Lo pagado con saldo vuelve como saldo (aunque se pidiera efectivo)');
  ok((await creditOf(A.H, o2.clientId)).balance === cur + 30, 'El saldo del cliente se recupera');
  // Un pago ya devuelto no se anula
  const pr = await one(A.H, 50);
  const pp = (await pay(A.H, pr.id, { full: true, method: 'Efectivo' })).body.payment;
  await ret(A.H, pr.id, { amount: 50, reason: 'Todo', resolution: 'refund', refundMethod: 'Efectivo' });
  r = await post(A.H, `/api/payments/${pp.id}/void`, { reason: 'Quiero anularlo' });
  ok(r.status === 400 && /devuelto/.test(r.body.error), 'Un pago ya reembolsado no se puede anular');

  // ── Informes y pantalla Pagos: cobrado = pagos − reembolsos, sin «Saldo a favor» ──
  const R = await reg('Dev Informes');
  await db.query('UPDATE tenants SET timezone=$1, plan=$2 WHERE id=$3', [TZ, 'pro', R.id]);
  const ra = await one(R.H, 100, { clientName: 'Rita Reporte' });
  await pay(R.H, ra.id, { full: true, method: 'Efectivo' });
  await ret(R.H, ra.id, { amount: 30, reason: 'A saldo', resolution: 'credit' });          // al saldo: no es efectivo que sale
  const rb = await one(R.H, 50, { clientId: ra.clientId });
  await pay(R.H, rb.id, { amount: 30, method: 'Saldo a favor' });                          // no es dinero nuevo
  await pay(R.H, rb.id, { amount: 20, method: 'Efectivo' });
  let rep = (await get(R.H, '/api/reports?period=hoy&tz=' + TZ)).body;
  ok(rep.cobrado === 120, 'Informes: cobrado = 100 + 20 en efectivo (el saldo a favor no suma ni resta) → ' + rep.cobrado);
  ok(rep.cobrosPorMetodo.length === 1 && rep.cobrosPorMetodo[0][0] === 'Efectivo' && rep.cobrosPorMetodo[0][1] === 120, 'Informes: solo «Efectivo» por método');
  r = await ret(R.H, rb.id, { amount: 10, reason: 'Sobró', resolution: 'refund', refundMethod: 'efectivo' });
  ok(r.status === 200 && r.body.creditNote.refunds[0].amountBase === 10 && r.body.creditNote.refunds[0].method === 'Efectivo', 'Reembolso de 10 en efectivo');
  rep = (await get(R.H, '/api/reports?period=hoy&tz=' + TZ)).body;
  ok(rep.cobrado === 110 && rep.cobrosPorMetodo[0][1] === 110, 'Informes: el reembolso resta (110)');
  const pg = (await get(R.H, '/api/payments?period=today&tz=' + TZ)).body;
  ok(pg.totals.total === 110 && pg.totals.byMethod.length === 1 && pg.totals.byMethod[0].method === 'Efectivo', 'Pagos: total 110 sin «Saldo a favor»');
  const refRows = pg.payments.filter(p => p.kind === 'refund');
  ok(refRows.length === 2 && refRows.every(p => p.amountBase < 0 && p.amount < 0 && /^#\d{4}$/.test(p.orderNumber)), 'Pagos: los reembolsos salen como filas negativas');
  ok(pg.payments.some(p => p.method === 'Saldo a favor' && p.kind === 'payment'), 'Pagos: el pago con saldo a favor aparece en la lista');
  ok(pg.totalCount === pg.payments.length, 'Pagos: el conteo incluye pagos y reembolsos');
  const pgm = (await get(R.H, '/api/payments?period=today&method=efectivo&tz=' + TZ)).body;
  ok(pgm.totals.total === 110 && pgm.payments.some(p => p.kind === 'refund' && p.method === 'Efectivo'), 'Pagos: el filtro por método incluye los reembolsos de ese método');

  // ── Aislamiento entre negocios ──
  const secret = await two(A.H);
  await pay(A.H, secret.id, { full: true, method: 'Efectivo' });
  const aClient = secret.clientId;
  r = await ret(Bt.H, secret.id, { amount: 5, reason: 'x', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 404, 'B no puede devolver un pedido de A');
  r = await post(Bt.H, `/api/orders/${secret.id}/cancel`, { reason: 'x' });
  ok(r.status === 404, 'B no puede anular un pedido de A');
  r = await post(Bt.H, `/api/orders/${secret.id}/convert`, {});
  ok(r.status === 404, 'B no puede convertir un documento de A');
  r = await get(Bt.H, `/api/orders/${secret.id}/returns`);
  ok(r.status === 404, 'B no puede leer las devoluciones de A');
  r = await get(Bt.H, `/api/clients/${aClient}/credit`);
  ok(r.status === 404, 'B no puede leer el saldo a favor de un cliente de A');
  r = await get(Bt.H, '/api/clients/no-uuid/credit');
  ok(r.status === 404, 'Id de cliente que no es UUID → 404');
  const bOrder = await one(Bt.H, 100);
  await pay(Bt.H, bOrder.id, { full: true, method: 'Efectivo' });
  r = await ret(Bt.H, bOrder.id, { items: [{ orderItemId: secret.items[0].id, qty: 1 }], reason: 'x', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400, 'B no puede devolver un artículo que es de un pedido de A');
  r = await post(Bt.H, '/api/orders', { clientName: 'Intruso', clientId: aClient, items: [{ name: 'x', qty: 1, unitPrice: 1 }] });
  ok(r.status === 400, 'B no puede crear un pedido a nombre de un cliente de A (ni usar su saldo)');
  r = await patch(Bt.H, `/api/orders/${bOrder.id}`, { client_id: aClient });
  ok(r.status === 400, 'B no puede asignar su pedido a un cliente de A');
  ok(Number((await db.query('SELECT COUNT(*) n FROM credit_notes WHERE order_id=$1', [secret.id])).rows[0].n) === 0, 'Ningún intento de B dejó rastro en el pedido de A');
  ok((await get(A.H, '/api/clients')).body.every(c => c.credit !== undefined), 'Cada ficha de A trae su campo credit');
  r = await get(Bt.H, '/api/clients');
  ok(r.body.every(c => c.credit === 0), 'Las fichas de B no ven saldos de A');

  // ── Demos ──
  const adm = await adminToken();
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm, 'X-Demo-Key': DEMO_KEY };
  const email = 'demociclo' + Date.now() + '@test.local';
  const demo = (await j('/api/admin/demos', { method: 'POST', headers: AH, body: JSON.stringify({ email, businessName: 'Demo Ciclo', days: 3, sendEmail: false }) })).body;
  const login = (await j('/api/tenant/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: demo.password }) })).body;
  const D = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  const dOrders = (await get(D, '/api/orders')).body;
  const quotes = dOrders.filter(o => o.kind === 'quote');
  ok(quotes.length >= 1 && quotes.length <= 2 && quotes.every(q => /^P-\d{4}$/.test(q.orderNumber)), 'Demo: trae 1–2 presupuestos (' + quotes.length + ')');
  ok(dOrders.some(o => o.deliveryStatus === 'preparing') && dOrders.some(o => o.deliveryStatus === 'on_the_way'), 'Demo: un pedido Preparando y uno En camino');
  const canc = dOrders.find(o => o.cancelled);
  ok(canc && canc.cancelReason && canc.cancelReason.length > 5 && canc.balance === 0, 'Demo: un pedido anulado con su motivo');
  const withNote = dOrders.find(o => o.creditedTotal > 0);
  ok(withNote && withNote.balance === 0 && withNote.payStatus === 'ok', 'Demo: una devolución con saldo a favor, el pedido sigue pagado');
  const dClients = (await get(D, '/api/clients')).body;
  const withCredit = dClients.find(c => c.credit > 0);
  ok(!!withCredit && withCredit.id === withNote.clientId, 'Demo: el cliente de la devolución tiene saldo a favor');
  ok(dOrders.every(o => o.kind === 'quote' || /^#\d{4}$/.test(o.orderNumber)) && new Set(dOrders.filter(o => o.kind === 'order').map(o => o.orderNumber)).size === dOrders.filter(o => o.kind === 'order').length, 'Demo: numeración de pedidos sin huecos duplicados');
  const dSet = (await get(D, '/api/tenant/settings')).body;
  ok(dSet.tax.enabled === false && dSet.zones.length >= 3, 'Demo: impuesto apagado y zonas de ejemplo');
  const dRep = (await get(D, '/api/reports?period=7dias&tz=' + TZ)).body;
  ok(dRep.cancelados >= 1, 'Demo: el informe cuenta el pedido anulado');
  // rutas permitidas
  r = await get(D, `/api/clients/${withCredit.id}/credit`);
  ok(r.status === 200 && r.body.balance === withCredit.credit, 'Demo: GET saldo a favor permitido');
  r = await get(D, `/api/orders/${withNote.id}/returns`);
  ok(r.status === 200 && r.body.creditNotes.length === 1 && r.body.creditNotes[0].number === 'NC-0001', 'Demo: GET devoluciones permitido');
  r = await post(D, `/api/orders/${quotes[0].id}/convert`, {});
  ok(r.status === 200 && r.body.order.kind === 'order', 'Demo: convertir un presupuesto');
  const pend = dOrders.find(o => o.kind === 'order' && !o.cancelled && o.amountPaid === 0 && o.clientId);
  r = await post(D, `/api/orders/${pend.id}/cancel`, { reason: 'Prueba de demo' });
  ok(r.status === 200 && r.body.order.cancelled, 'Demo: anular un pedido');
  const paid = dOrders.find(o => o.kind === 'order' && !o.cancelled && o.amountPaid > 20 && o.creditedTotal === 0 && o.items.length);
  r = await ret(D, paid.id, { amount: 5, reason: 'Prueba', resolution: 'credit' });
  ok(r.status === 200, 'Demo: devolución permitida');
  ok(metaCalls().length === 0, 'Demo: ninguna llamada a Meta');
  // topes
  const oid = paid.id;
  const fill = async (table, n, cols, vals) => db.query(`INSERT INTO ${table} (${cols}) SELECT ${vals} FROM generate_series(1, $1)`, [n]);
  const cnNow = Number((await db.query('SELECT COUNT(*) n FROM credit_notes WHERE tenant_id=$1', [demo.tenantId])).rows[0].n);
  await fill('credit_notes', 200 - cnNow, 'tenant_id, order_id, number, amount_base, reason', `'${demo.tenantId}', '${oid}', 1000 + generate_series, 1, 'relleno'`);
  r = await ret(D, paid.id, { amount: 1, reason: 'Tope', resolution: 'credit' });
  ok(r.status === 429 && r.body.error === 'demo_limit', 'Demo: tope de 200 notas de crédito');
  await db.query('DELETE FROM credit_notes WHERE tenant_id=$1 AND reason=$2', [demo.tenantId, 'relleno']);
  const rfNow = Number((await db.query('SELECT COUNT(*) n FROM refunds WHERE tenant_id=$1', [demo.tenantId])).rows[0].n);
  await fill('refunds', 300 - rfNow, 'tenant_id, order_id, amount, currency, amount_base, method', `'${demo.tenantId}', '${oid}', 1, 'USD', 1, 'Efectivo'`);
  const pend2 = dOrders.find(o => o.kind === 'order' && !o.cancelled && o.id !== pend.id && o.amountPaid === 0);
  r = await post(D, `/api/orders/${pend2.id}/cancel`, { reason: 'Tope' });
  ok(r.status === 429 && r.body.error === 'demo_limit', 'Demo: tope de 300 reembolsos');
  r = await ret(D, paid.id, { amount: 1, reason: 'Tope', resolution: 'credit' });
  ok(r.status === 429, 'Demo: el tope de reembolsos también frena las devoluciones');
  await db.query('DELETE FROM refunds WHERE tenant_id=$1 AND method=$2 AND amount=1', [demo.tenantId, 'Efectivo']);
  const ceNow = Number((await db.query('SELECT COUNT(*) n FROM client_credit_entries WHERE tenant_id=$1', [demo.tenantId])).rows[0].n);
  await fill('client_credit_entries', 600 - ceNow, 'tenant_id, client_id, amount, kind', `'${demo.tenantId}', '${withCredit.id}', 0.01, 'refund_to_credit'`);
  r = await pay(D, pend2.id, { amount: 1, method: 'Saldo a favor' });
  ok(r.status === 429 && r.body.error === 'demo_limit', 'Demo: tope de 600 movimientos de saldo a favor');
  // Reiniciar datos: vuelve a sembrar y limpia las tablas nuevas
  r = await post(AH, `/api/admin/demos/${demo.tenantId}/reset-data`, {});
  ok(r.status === 200, 'Admin: reiniciar datos de la demo');
  const cnt = async (t) => Number((await db.query(`SELECT COUNT(*) n FROM ${t} WHERE tenant_id=$1`, [demo.tenantId])).rows[0].n);
  ok(await cnt('credit_notes') === 1 && await cnt('refunds') === 1 && await cnt('client_credit_entries') === 1, 'Reiniciar: queda solo lo del seed (1 nota, 1 reembolso, 1 movimiento)');
  // Hacer real: todo vacío
  r = await post(AH, `/api/admin/demos/${demo.tenantId}/convert`, {});
  ok(r.status === 200 && await cnt('credit_notes') === 0 && await cnt('refunds') === 0 && await cnt('client_credit_entries') === 0 && await cnt('orders') === 0, 'Hacer real: borra también las tablas nuevas');
  const seqs = (await db.query('SELECT quote_seq, credit_note_seq, order_seq FROM tenants WHERE id=$1', [demo.tenantId])).rows[0];
  ok(seqs.quote_seq === 0 && seqs.credit_note_seq === 0 && seqs.order_seq === 0, 'Hacer real: los contadores vuelven a 0');
  // Una demo sigue sin llegar a rutas fuera de la lista
  r = await post(D, '/api/payments/' + '00000000-0000-4000-8000-000000000000' + '/refund', {});
  ok(r.status === 403 || r.status === 404, 'Una ruta nueva inventada no queda abierta a demos');

  await db.end();
});
