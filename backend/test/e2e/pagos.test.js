// Fase 2: pagos de verdad (abonos, saldo derivado, anulación, moneda, historial, ajustes, informes, demos)
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, metaCalls, clearMeta, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const { backfillLegacyPayments } = require('../../pagos');
const post = (H, u, b) => send(H, 'POST', u, b);
const TZ = 'America/Caracas';

run(async () => {
  const db = await dbConnect();
  const A = await reg('Pagos A'), Bt = await reg('Pagos B');
  await db.query('UPDATE tenants SET timezone=$1, plan=$2 WHERE id=$3', [TZ, 'pro', A.id]);
  const today = (await db.query(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') d`, [TZ])).rows[0].d;
  const newOrder = async (H, total, extra = {}) =>
    (await post(H, '/api/orders', { clientName: 'Cliente ' + total, items: [{ name: 'Art', qty: 1, unitPrice: total }], ...extra })).body;
  const pay = (H, id, b) => post(H, `/api/orders/${id}/payments`, b);

  // ── Abono parcial → partial; segundo pago → ok ──
  const o1 = await newOrder(A.H, 100);
  ok(o1.payStatus === 'pend' && o1.amountPaid === 0 && o1.balance === 100, 'Pedido nuevo: pend, cobrado 0, saldo 100');
  let r = await j(`/api/orders/${o1.id}/payments`, { headers: A.H });
  ok(r.status === 200 && r.body.payments.length === 0 && r.body.balance === 100 && r.body.payStatus === 'pend', 'GET pagos: vacío, saldo 100');
  r = await pay(A.H, o1.id, { amount: 40, method: 'Pago Móvil', reference: 'R-001', note: 'abono' });
  ok(r.status === 200 && r.body.order.payStatus === 'partial' && r.body.order.amountPaid === 40 && r.body.order.balance === 60, 'Abono de 40 → partial, saldo 60');
  ok(r.body.payment.amountBase === 40 && r.body.payment.currency === 'USD' && r.body.payment.exchangeRate === 1 && r.body.payment.method === 'Pago Móvil' && r.body.payment.voided === false, 'El pago devuelto trae moneda base, tasa 1 y método');
  ok(r.body.order.items.length === 1, 'La respuesta incluye el pedido con sus artículos');
  const p1 = r.body.payment;
  r = await pay(A.H, o1.id, { amount: 60, method: 'Efectivo' });
  ok(r.status === 200 && r.body.order.payStatus === 'ok' && r.body.order.balance === 0, 'Segundo pago de 60 → ok, saldo 0');
  const p2 = r.body.payment;
  r = await pay(A.H, o1.id, { amount: 1, method: 'Efectivo' });
  ok(r.status === 400 && /pagado/.test(r.body.error), 'Pedido ya pagado → 400');
  const listed = (await j('/api/orders', { headers: A.H })).body.find(o => o.id === o1.id);
  ok(listed.payStatus === 'ok' && listed.amountPaid === 100, 'GET /api/orders refleja el cobro');

  // ── Sobrepago ──
  const o2 = await newOrder(A.H, 50);
  r = await pay(A.H, o2.id, { amount: 60, method: 'Efectivo' });
  ok(r.status === 400 && r.body.error === 'El pago supera el saldo pendiente (50.00 USD)', 'Sobrepago → 400 con el saldo');
  r = await pay(A.H, o2.id, { amount: 20, method: 'Efectivo' });
  r = await pay(A.H, o2.id, { amount: 30.01, method: 'Efectivo' });
  ok(r.status === 400 && r.body.error === 'El pago supera el saldo pendiente (30.00 USD)', 'Sobrepago tras un abono usa el saldo restante');

  // ── Pagos simultáneos no superan el saldo ──
  const o3 = await newOrder(A.H, 100);
  let rs = await Promise.all([1, 2, 3].map(() => pay(A.H, o3.id, { amount: 70, method: 'Efectivo' })));
  ok(rs.filter(x => x.status === 200).length === 1 && rs.filter(x => x.status === 400).length === 2, 'Tres pagos de 70 a la vez sobre 100: solo uno entra');
  const fin3 = (await j(`/api/orders/${o3.id}/payments`, { headers: A.H })).body;
  ok(fin3.amountPaid === 70 && fin3.payments.length === 1, 'Quedan 70 cobrados y un solo pago');
  const o3b = await newOrder(A.H, 100);
  rs = await Promise.all([1, 2].map(() => pay(A.H, o3b.id, { amount: 50, method: 'Efectivo' })));
  ok(rs.every(x => x.status === 200), 'Dos pagos de 50 a la vez sobre 100 entran los dos');
  ok((await j(`/api/orders/${o3b.id}/payments`, { headers: A.H })).body.payStatus === 'ok', '… y el pedido queda ok');
  const dbPaid = (await db.query('SELECT amount_paid, pay_status FROM orders WHERE id=$1', [o3b.id])).rows[0];
  ok(Number(dbPaid.amount_paid) === 100 && dbPaid.pay_status === 'ok', 'En la base amount_paid = 100');

  // ── Anular ──
  r = await post(A.H, `/api/payments/${p1.id}/void`, {});
  ok(r.status === 400, 'Anular sin motivo → 400');
  r = await post(A.H, `/api/payments/${p1.id}/void`, { reason: 'x'.repeat(201) });
  ok(r.status === 400, 'Motivo de más de 200 caracteres → 400');
  r = await post(A.H, `/api/payments/${p1.id}/void`, { reason: 'Se registró por error' });
  ok(r.status === 200 && r.body.payment.voided === true && r.body.payment.voidReason === 'Se registró por error', 'Anular → pago marcado');
  ok(r.body.order.payStatus === 'partial' && r.body.order.amountPaid === 60 && r.body.order.balance === 40, 'Al anular el de 40, el pedido vuelve a partial (cobrado 60)');
  r = await post(A.H, `/api/payments/${p1.id}/void`, { reason: 'otra vez' });
  ok(r.status === 400 && /anulado/.test(r.body.error), 'Anular dos veces → 400');
  r = await j(`/api/orders/${o1.id}/payments`, { headers: A.H });
  ok(r.body.payments.length === 2 && r.body.payments.find(p => p.id === p1.id).voided === true, 'El pago anulado sigue en la lista, con su flag');
  r = await j(`/api/orders/${o1.id}/events`, { headers: A.H });
  const types = r.body.events.map(e => e.type);
  ok(types[0] === 'created' && types.filter(t => t === 'payment_added').length === 2 && types.includes('payment_voided'), 'Historial: created, 2 payment_added y payment_voided');
  ok(r.body.events.find(e => e.type === 'payment_voided').data.reason === 'Se registró por error', 'El evento de anulación guarda el motivo');
  // El pago anulado se puede volver a cobrar (el saldo vuelve a estar libre)
  r = await pay(A.H, o1.id, { amount: 40, method: 'Zelle', reference: 'Z-9' });
  ok(r.status === 200 && r.body.order.payStatus === 'ok', 'Tras anular se puede cobrar de nuevo el saldo');

  // ── Moneda distinta con tasa ──
  const o4 = await newOrder(A.H, 100);
  r = await pay(A.H, o4.id, { amount: 1000, currency: 'VES', method: 'Pago Móvil' });
  ok(r.status === 400 && /tasa/i.test(r.body.error), 'Otra moneda sin tasa → 400');
  r = await pay(A.H, o4.id, { amount: 1000, currency: 'ves', exchangeRate: 0, method: 'Pago Móvil' });
  ok(r.status === 400, 'Tasa 0 → 400');
  r = await pay(A.H, o4.id, { amount: 1825, currency: 'ves', exchangeRate: 36.5, method: 'Pago Móvil', reference: 'PM-77' });
  ok(r.status === 200 && r.body.payment.currency === 'VES' && r.body.payment.amount === 1825 && r.body.payment.amountBase === 50 && r.body.payment.exchangeRate === 36.5, '1825 VES a 36.5 = 50 USD');
  ok(r.body.order.payStatus === 'partial' && r.body.order.amountPaid === 50, 'El saldo cuenta la moneda base');
  r = await pay(A.H, o4.id, { amount: 1825.2, currency: 'VES', exchangeRate: 36.5, method: 'Pago Móvil' });
  ok(r.status === 200 && r.body.payment.amountBase === 50 && r.body.order.payStatus === 'ok', 'Redondeo de un centavo al cobrar el saldo exacto: se ajusta al saldo');
  const o4b = await newOrder(A.H, 10);
  r = await pay(A.H, o4b.id, { amount: 1000, currency: 'VES', exchangeRate: 36.5, method: 'Pago Móvil' });
  ok(r.status === 400 && /supera el saldo/.test(r.body.error), 'Pago en otra moneda que supera el saldo → 400');

  // ── Validaciones del cuerpo ──
  const o5 = await newOrder(A.H, 100);
  for (const [d, b] of [
    ['monto 0', { amount: 0, method: 'X' }], ['monto negativo', { amount: -5, method: 'X' }], ['monto texto', { amount: 'abc', method: 'X' }],
    ['monto enorme', { amount: 1e9, method: 'X' }], ['monto vacío', { method: 'X' }],
    ['sin método', { amount: 5 }], ['método largo', { amount: 5, method: 'm'.repeat(61) }],
    ['referencia larga', { amount: 5, method: 'X', reference: 'r'.repeat(81) }], ['nota larga', { amount: 5, method: 'X', note: 'n'.repeat(301) }],
    ['fecha inválida', { amount: 5, method: 'X', paidAt: 'ayer' }], ['fecha inexistente', { amount: 5, method: 'X', paidAt: '2026-02-31' }],
    ['fecha futura', { amount: 5, method: 'X', paidAt: '2099-01-01' }], ['moneda inválida', { amount: 5, method: 'X', currency: 'dólares!' }],
  ]) {
    r = await pay(A.H, o5.id, b);
    ok(r.status === 400, `Rechaza ${d} (400)`);
  }
  r = await send(A.H, 'POST', `/api/orders/${o5.id}/payments`, undefined);
  ok(r.status === 400, 'Sin cuerpo → 400, no 500');
  ok((await j(`/api/orders/${o5.id}/payments`, { headers: A.H })).body.payments.length === 0, 'Ninguno de los rechazos dejó pagos');
  r = await pay(A.H, o5.id, { amount: 10, method: 'Efectivo', paidAt: '2026-01-15' });
  ok(r.status === 200, 'Pago con fecha pasada (solo día) → 200');
  const dated = r.body.payment;
  ok(new Date(dated.paidAt).toISOString().slice(0, 10) >= '2026-01-15' && new Date(dated.paidAt).toISOString().slice(0, 10) <= '2026-01-16', 'La fecha sin hora cae ese día');
  const zero = (await post(A.H, '/api/orders', { clientName: 'Cero', totalPrice: 0 })).body;
  r = await pay(A.H, zero.id, { amount: 5, method: 'Efectivo' });
  ok(r.status === 400, 'Pedido con total 0 → 400');

  // ── PATCH: pay_status ya no se acepta; el total no baja de lo cobrado ──
  const o6 = await newOrder(A.H, 100);
  r = await send(A.H, 'PATCH', '/api/orders/' + o6.id, { pay_status: 'ok' });
  ok(r.status === 400 && /Registrar pago/.test(r.body.error), 'PATCH pay_status → 400 con el mensaje');
  ok((await j('/api/orders', { headers: A.H })).body.find(o => o.id === o6.id).payStatus === 'pend', '… y el pedido no cambió');
  await pay(A.H, o6.id, { amount: 60, method: 'Efectivo' });
  r = await send(A.H, 'PATCH', '/api/orders/' + o6.id, { items: [{ name: 'Art', qty: 1, unitPrice: 50 }] });
  ok(r.status === 400 && r.body.error === 'El total no puede quedar por debajo de lo ya cobrado (60.00 USD)', 'Total bajo lo cobrado → 400');
  ok((await j('/api/orders', { headers: A.H })).body.find(o => o.id === o6.id).totalPrice === '100.00', '… y no se guardó nada');
  r = await send(A.H, 'PATCH', '/api/orders/' + o6.id, { items: [{ name: 'Art', qty: 1, unitPrice: 60 }] });
  ok(r.status === 200 && r.body.payStatus === 'ok' && r.body.balance === 0, 'Total igual a lo cobrado → ok');
  r = await send(A.H, 'PATCH', '/api/orders/' + o6.id, { items: [{ name: 'Art', qty: 1, unitPrice: 150 }] });
  ok(r.status === 200 && r.body.payStatus === 'partial' && r.body.balance === 90, 'Subir el total vuelve a partial (saldo 90)');
  r = await send(A.H, 'PATCH', '/api/orders/' + o6.id, { delivery_status: 'delivered' });
  ok(r.status === 200 && r.body.payStatus === 'partial', 'Cambiar la entrega no toca el cobro');
  const ev6 = (await j(`/api/orders/${o6.id}/events`, { headers: A.H })).body.events;
  ok(ev6.some(e => e.type === 'edited' && e.data.fields.includes('total_price')) && ev6.some(e => e.type === 'status_changed' && e.data.to === 'delivered'), 'Historial: edited (total) y status_changed (entrega)');

  // ── POST /api/orders: payStatus se ignora; initialPayment ──
  const o7 = await newOrder(A.H, 80, { payStatus: 'ok' });
  ok(o7.payStatus === 'pend' && o7.amountPaid === 0, 'POST con payStatus ok NO lo marca pagado');
  const o8 = await newOrder(A.H, 80, { initialPayment: { amount: 30, method: 'Efectivo', reference: 'caja' } });
  ok(o8.payStatus === 'partial' && o8.amountPaid === 30 && o8.balance === 50, 'initialPayment crea el pago en el alta');
  ok((await j(`/api/orders/${o8.id}/payments`, { headers: A.H })).body.payments.length === 1, '… y queda registrado');
  const before = (await j('/api/orders', { headers: A.H })).body.length;
  r = await post(A.H, '/api/orders', { clientName: 'Mal', items: [{ name: 'A', qty: 1, unitPrice: 10 }], initialPayment: { amount: 99, method: 'Efectivo' } });
  ok(r.status === 400 && (await j('/api/orders', { headers: A.H })).body.length === before, 'initialPayment que supera el total → 400 y NO se crea el pedido');
  const o9 = await newOrder(A.H, 40, { initialPayment: { amount: 40, method: 'Zelle' } });
  ok(o9.payStatus === 'ok', 'initialPayment por el total → ok');
  ok((await j(`/api/orders/${o9.id}/events`, { headers: A.H })).body.events.map(e => e.type).join() === 'created,payment_added', 'Historial del alta: created, payment_added');

  // ── Aislamiento entre negocios ──
  r = await j(`/api/orders/${o1.id}/payments`, { headers: Bt.H });
  ok(r.status === 404, 'B no ve los pagos de un pedido de A (404)');
  r = await pay(Bt.H, o2.id, { amount: 1, method: 'X' });
  ok(r.status === 404, 'B no puede pagar un pedido de A (404)');
  r = await post(Bt.H, `/api/payments/${p2.id}/void`, { reason: 'hack' });
  ok(r.status === 404, 'B no puede anular un pago de A (404)');
  ok((await j(`/api/orders/${o1.id}/payments`, { headers: A.H })).body.payments.find(p => p.id === p2.id).voided === false, '… y el pago de A sigue vigente');
  r = await j(`/api/orders/${o1.id}/events`, { headers: Bt.H });
  ok(r.status === 404, 'B no ve el historial de un pedido de A (404)');
  for (const u of ['/api/orders/xx/payments', '/api/orders/xx/events']) ok((await j(u, { headers: A.H })).status === 404, `${u} con id inválido → 404`);
  ok((await post(A.H, '/api/payments/xx/void', { reason: 'x' })).status === 404, 'Anular con id inválido → 404');
  const bOrder = await newOrder(Bt.H, 30);
  r = await j('/api/payments?from=2020-01-01&to=2099-12-31', { headers: Bt.H });
  ok(r.status === 400 || r.body.payments.length === 0, 'B no ve cobros de A en el listado');
  r = await j(`/api/payments?from=${today}&to=${today}`, { headers: Bt.H });
  ok(r.status === 200 && r.body.payments.length === 0 && r.body.totals.total === 0, 'Listado de B vacío (sin pagos propios)');

  // ── Relleno de una sola vez (pedidos pagados "a la antigua") ──
  const ins = async (total, label, status = 'ok') => (await db.query(`
    INSERT INTO orders (tenant_id, client_name, total_price, pay_status, pay_method_label, created_at)
    VALUES ($1, 'Antiguo', $2, $3, $4, now() - interval '3 days') RETURNING id`, [Bt.id, total, status, label])).rows[0].id;
  const l1 = await ins(25, 'Zelle'), l2 = await ins(0, 'Efectivo'), l3 = await ins(12.5, '—'), l4 = await ins(30, 'Zelle', 'pend');
  const filled = await backfillLegacyPayments(db);
  ok(filled >= 2, `Relleno: ${filled} pedido(s) convertidos`);
  const lp = async id => (await db.query('SELECT * FROM payments WHERE order_id=$1', [id])).rows;
  let rows = await lp(l1);
  ok(rows.length === 1 && Number(rows[0].amount) === 25 && Number(rows[0].amount_base) === 25 && rows[0].method === 'Zelle' && rows[0].currency === 'USD' && Number(rows[0].exchange_rate) === 1 && rows[0].note === 'Registrado antes de la Fase 2', 'Relleno: pago por el total con su método');
  ok(Math.abs(new Date(rows[0].paid_at) - (Date.now() - 3 * 86400000)) < 60000, 'Relleno: paid_at = fecha de creación del pedido');
  rows = await lp(l3);
  ok(rows.length === 1 && rows[0].method === 'Sin Especificar', 'Relleno: etiqueta "—" → "Sin Especificar"');
  ok((await lp(l2)).length === 0 && (await lp(l4)).length === 0, 'Relleno: ni el pedido de total 0 ni el pendiente reciben pago');
  const o = (await db.query('SELECT amount_paid, pay_status FROM orders WHERE id = ANY($1) ORDER BY total_price', [[l1, l2, l3]])).rows;
  ok(Number(o[0].amount_paid) === 0 && o[0].pay_status === 'ok' && Number(o[1].amount_paid) === 12.5 && Number(o[2].amount_paid) === 25, 'Relleno: amount_paid = total; total 0 queda ok con 0');
  ok((await backfillLegacyPayments(db)) === 0 && (await lp(l1)).length === 1, 'Reejecutar el relleno no duplica pagos');
  ok(Number((await db.query(`SELECT COUNT(*) n FROM order_events WHERE order_id=$1 AND type='migrated'`, [l1])).rows[0].n) === 1, 'Relleno: evento "migrated" una sola vez');
  ok((await db.query(`SELECT 1 FROM schema_migrations WHERE name='2026-11-25-pagos-relleno'`)).rows.length === 1, 'La migración quedó marcada como aplicada');
  const legacy = (await j('/api/orders', { headers: Bt.H })).body.find(x => x.id === l1);
  ok(legacy.payStatus === 'ok' && legacy.amountPaid === 25 && legacy.balance === 0, 'La API muestra el pedido antiguo como cobrado');

  // ── Clientes con saldo ──
  const cli = (await post(A.H, '/api/clients', { name: 'Rosa Saldo' })).body;
  ok(cli.balance === 0 && cli.ordersWithBalance === 0, 'Cliente nuevo: saldo 0');
  const c1 = await newOrder(A.H, 100, { clientId: cli.id, clientName: 'Rosa Saldo' });
  const c2 = await newOrder(A.H, 50, { clientId: cli.id, clientName: 'Rosa Saldo' });
  const c3 = await newOrder(A.H, 20, { clientId: cli.id, clientName: 'Rosa Saldo', initialPayment: { amount: 20, method: 'Efectivo' } });
  await pay(A.H, c1.id, { amount: 30, method: 'Efectivo' });
  let cl = (await j('/api/clients', { headers: A.H })).body.find(c => c.id === cli.id);
  ok(cl.balance === 120 && cl.ordersWithBalance === 2, 'Cliente: saldo = 70 + 50 (el pagado no cuenta)');
  ok((await j('/api/clients', { headers: A.H })).body.every(c => typeof c.balance === 'number'), 'Todas las fichas traen balance');
  r = await send(A.H, 'PATCH', '/api/clients/' + cli.id, { name: 'Rosa Saldo', phone: '' });
  ok(r.status === 200 && r.body.balance === 120 && r.body.ordersWithBalance === 2, 'La ficha editada también devuelve el saldo');
  ok((await j('/api/clients', { headers: Bt.H })).body.every(c => c.id !== cli.id && c.balance <= 30), 'El saldo de A no aparece en las fichas de B');

  // ── Ajustes del negocio ──
  r = await j('/api/tenant/settings', { headers: A.H });
  ok(r.status === 200 && r.body.baseCurrency === 'USD' && Array.isArray(r.body.paymentMethods) && r.body.paymentMethods.length === 0 && r.body.canChangeBaseCurrency === false, 'Ajustes por defecto (A ya tiene pagos: no puede cambiar de moneda)');
  const methods = [{ id: 'pm', name: 'Pago Móvil', enabled: true, details: { banco: '0102', telefono: '0414-0000000' } }, { id: 'ef', name: 'Efectivo', enabled: false }];
  r = await send(A.H, 'PUT', '/api/tenant/settings', { paymentMethods: methods, deliveryMethods: { motorizado: { enabled: true, label: 'Moto', items: ['Juan'] } } });
  ok(r.status === 200 && r.body.paymentMethods.length === 2 && r.body.paymentMethods[0].details.banco === '0102' && r.body.paymentMethods[1].enabled === false && r.body.deliveryMethods.motorizado.label === 'Moto', 'PUT ajustes guarda métodos y entrega');
  r = await j('/api/tenant/settings', { headers: A.H });
  ok(r.body.paymentMethods[0].name === 'Pago Móvil' && r.body.deliveryMethods.motorizado.label === 'Moto', 'GET devuelve lo guardado');
  r = await send(A.H, 'PUT', '/api/tenant/settings', { paymentMethods: [] });
  ok(r.status === 200 && r.body.paymentMethods.length === 0 && r.body.deliveryMethods.motorizado.label === 'Moto', 'PUT parcial: no toca lo que no se envía');
  for (const [d, b] of [
    ['21 métodos', { paymentMethods: Array.from({ length: 21 }, (_, i) => ({ id: 'm' + i, name: 'M' + i })) }],
    ['id repetido', { paymentMethods: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }] }],
    ['sin nombre', { paymentMethods: [{ id: 'a', name: '' }] }],
    ['detalle largo', { paymentMethods: [{ id: 'a', name: 'A', details: { x: 'y'.repeat(201) } }] }],
    ['detalle no texto', { paymentMethods: [{ id: 'a', name: 'A', details: { x: 5 } }] }],
    ['métodos no lista', { paymentMethods: { a: 1 } }],
    ['entrega clave desconocida', { deliveryMethods: { x: { enabled: true } } }],
    ['entrega items no texto', { deliveryMethods: { motorizado: { items: [{ a: '<img onerror=alert(1)>' }] } } }],
    ['entrega items string', { deliveryMethods: { motorizado: { items: '<img onerror=alert(1)>' } } }],
    ['entrega label largo', { deliveryMethods: { retiro: { label: 'x'.repeat(61) } } }],
    ['entrega campo extra', { deliveryMethods: { retiro: { precio: 4 } } }],
    ['entrega 31 items', { deliveryMethods: { retiro: { items: Array(31).fill('a') } } }],
    ['entrega lista', { deliveryMethods: [1] }],
    ['moneda fuera de lista', { baseCurrency: 'XXX' }],
    ['vacío', {}],
  ]) {
    r = await send(A.H, 'PUT', '/api/tenant/settings', b);
    ok(r.status === 400, `Ajustes: rechaza ${d} (400)`);
  }
  r = await send(A.H, 'PUT', '/api/tenant/settings', { baseCurrency: 'VES' });
  ok(r.status === 400 && /ya hay pagos/.test(r.body.error), 'No se cambia la moneda base si ya hay pagos');
  const nb = await reg('Pagos Moneda');
  r = await send(nb.H, 'PUT', '/api/tenant/settings', { baseCurrency: 'ves' });
  ok(r.status === 200 && r.body.baseCurrency === 'VES' && r.body.canChangeBaseCurrency === true, 'Sin pagos sí se cambia la moneda base');
  const nbo = await newOrder(nb.H, 100);
  r = await pay(nb.H, nbo.id, { amount: 100, method: 'Efectivo' });
  ok(r.status === 200 && r.body.payment.currency === 'VES' && r.body.order.payStatus === 'ok', 'La moneda por defecto de un pago es la base del negocio');
  r = await send(nb.H, 'PUT', '/api/tenant/settings', { baseCurrency: 'USD' });
  ok(r.status === 400, 'Con un pago ya registrado no se puede volver a cambiar');
  ok((await j('/api/tenant/settings', { headers: Bt.H })).body.paymentMethods.length === 0, 'Los ajustes de A no aparecen en B');

  // ── Listado de cobros y totales por método ──
  r = await j(`/api/payments?from=${today}&to=${today}`, { headers: A.H });
  ok(r.status === 200 && r.body.timezone === TZ && r.body.truncated === false && r.body.baseCurrency === 'USD', 'GET /api/payments: periodo de hoy');
  const todays = r.body.payments;
  ok(todays.some(p => p.voided) && todays.every(p => /^#\d{4}$/.test(p.orderNumber) && typeof p.clientName === 'string'), 'Incluye anulados (flag) y número/cliente del pedido');
  const sumActive = Math.round(todays.filter(p => !p.voided).reduce((a, p) => a + p.amountBase, 0) * 100) / 100;
  ok(r.body.totals.total === sumActive && r.body.totals.count === todays.filter(p => !p.voided).length, 'El total general solo suma los no anulados');
  const bm = Object.fromEntries(r.body.totals.byMethod.map(m => [m.method, m.total]));
  const efectivo = Math.round(todays.filter(p => !p.voided && p.method === 'Efectivo').reduce((a, p) => a + p.amountBase, 0) * 100) / 100;
  ok(bm['Efectivo'] === efectivo && bm['Pago Móvil'] > 0, 'Totales por método en moneda base');
  ok(!todays.some(p => p.id === dated.id), 'El pago con fecha de enero no sale en "hoy"');
  const todayTotal = r.body.totals.total;
  r = await j(`/api/payments?from=${today}&to=${today}&method=${encodeURIComponent('Pago Móvil')}`, { headers: A.H });
  ok(r.body.payments.length > 0 && r.body.payments.every(p => p.method === 'Pago Móvil') && r.body.totals.byMethod.length === 1, 'Filtro por método');
  r = await j('/api/payments?from=2026-01-15&to=2026-01-15', { headers: A.H });
  ok(r.body.payments.length === 1 && r.body.payments[0].id === dated.id && r.body.totals.total === 10, 'Rango por día: el pago de enero aparece en su día');
  for (const q of ['from=2026-02-31', 'from=2026-03-02&to=2026-03-01', 'from=2020-01-01&to=2026-01-01']) {
    ok((await j('/api/payments?' + q, { headers: A.H })).status === 400, `Listado: rechaza ${q}`);
  }

  // ── Informes: cobrado y cobros por método ──
  r = await j('/api/reports?period=hoy', { headers: A.H });
  ok(r.status === 200 && r.body.cobrado === todayTotal, `reports.cobrado = cobros de hoy (${r.body.cobrado})`);
  ok(Array.isArray(r.body.cobrosPorMetodo) && r.body.cobrosPorMetodo.some(([m, v]) => m === 'Pago Móvil' && v === bm['Pago Móvil']), 'reports.cobrosPorMetodo por método');
  ok(typeof r.body.ventas === 'number' && Array.isArray(r.body.paymentMethods), 'Los campos existentes (ventas, paymentMethods) siguen');
  const ia = await send(A.H, 'GET', '/api/reports?period=hoy&canal=ig');
  ok(ia.status === 200 && ia.body.cobrado === 0, 'Con canal Instagram, cobrado cuenta solo pedidos de ese canal');
  r = await j('/api/reports?period=personalizado&from=2026-01-15&to=2026-01-15', { headers: A.H });
  ok(r.body.cobrado === 10, 'Informe de un día pasado: cobrado según fecha de pago');
  const vo = (await j(`/api/orders/${o1.id}/payments`, { headers: A.H })).body.payments.find(p => p.voided);
  ok(!!vo && todayTotal === sumActive, 'Los anulados no cuentan en informes');

  // ── Relleno tras el arranque (pedido 'ok' sin pago creado por la versión vieja) ──
  const late = await ins(40, 'Pago móvil');
  ok((await lp(late)).length === 0, 'Pedido ok sin pago insertado por SQL: aún sin pago');
  const { runPaymentsBackfill, normalizeMethodName } = require('../../pagos');
  const pg = require('pg');
  const bpool = new pg.Pool({ connectionString: process.env.TEST_DB_URL });
  ok((await runPaymentsBackfill(bpool)) >= 1 && (await lp(late)).length === 1, 'El relleno crea el pago del pedido tardío');
  ok((await lp(late))[0].method === 'Pago Móvil', 'El relleno guarda el método canónico');
  await runPaymentsBackfill(bpool);
  ok((await lp(late)).length === 1, 'Reejecutar el relleno no duplica');
  await bpool.end();
  ok((await db.query("SELECT 1 FROM pg_indexes WHERE indexname = 'payments_client_idx'")).rowCount === 1
    && (await db.query("SELECT 1 FROM pg_indexes WHERE indexname IN ('order_events_order_seq_idx','order_events_tenant_idx')")).rowCount === 2, 'Índices de pagos y eventos creados');

  // ── Pago completo (full) ──
  const f1 = await newOrder(A.H, 80, { initialPayment: { full: true, amount: 1, method: 'Efectivo' } });
  ok(f1.payStatus === 'ok' && f1.amountPaid === 80, 'initialPayment full:true cobra el total (ignora amount)');
  const f2 = await newOrder(A.H, 60);
  r = await pay(A.H, f2.id, { amount: 10, method: 'Efectivo' });
  r = await pay(A.H, f2.id, { full: true, method: 'Efectivo' });
  ok(r.status === 200 && r.body.payment.amountBase === 50 && r.body.order.payStatus === 'ok', 'full cobra el saldo pendiente');
  const f3 = await newOrder(A.H, 100);
  r = await pay(A.H, f3.id, { full: true, currency: 'VES', exchangeRate: 40, method: 'Pago Móvil' });
  ok(r.status === 200 && r.body.payment.amount === 4000 && r.body.payment.amountBase === 100 && r.body.order.payStatus === 'ok', 'full en otra moneda: monto = saldo × tasa');
  r = await pay(A.H, (await newOrder(A.H, 10)).id, { full: 'si', method: 'Efectivo' });
  ok(r.status === 400, 'full no booleano → 400');
  const f4 = await newOrder(A.H, 30, { initialPayment: { amount: 10, method: 'Efectivo' } });
  ok(f4.payStatus === 'partial' && f4.amountPaid === 10, 'initialPayment con amount sigue funcionando');

  // ── Métodos canónicos ──
  const nm = normalizeMethodName;
  ok(nm('Pago móvil') === 'Pago Móvil' && nm('pago MÓVIL ') === 'Pago Móvil' && nm('Efectivo $') === 'Efectivo' && nm('efectivo usd') === 'Efectivo'
    && nm('Binance Pay') === 'Binance' && nm('$') === '$' && nm('Tarjeta de crédito') === 'Tarjeta de Crédito', 'normalizeMethodName');
  const mt = await reg('Pagos Metodos');
  await db.query('UPDATE tenants SET timezone=$1, plan=$3 WHERE id=$2', [TZ, mt.id, 'pro']);
  for (const [m, a] of [['Pago móvil', 10], ['Pago Móvil', 5], ['Efectivo $', 7], ['Efectivo USD', 3], ['Binance Pay', 4], ['Pago Movil', 1]]) {
    const oo = await newOrder(mt.H, 100); await pay(mt.H, oo.id, { amount: a, method: m });
  }
  r = await j('/api/payments?period=today', { headers: mt.H });
  const bmm = Object.fromEntries(r.body.totals.byMethod.map(m => [m.method, m.total]));
  ok(bmm['Pago Móvil'] === 16 && bmm['Efectivo'] === 10 && bmm['Binance'] === 4 && r.body.totals.byMethod.length === 3, 'byMethod agrupa por nombre canónico');
  r = await j('/api/payments?period=today&method=' + encodeURIComponent('efectivo usd'), { headers: mt.H });
  ok(r.body.payments.length === 2 && r.body.totals.total === 10, 'El filtro por método usa el nombre canónico');
  r = await j('/api/reports?period=hoy', { headers: mt.H });
  ok(r.body.cobrosPorMetodo.some(([m, v]) => m === 'Pago Móvil' && v === 16) && r.body.cobrosPorMetodo.some(([m, v]) => m === 'Efectivo' && v === 10), 'cobrosPorMetodo agrupa por nombre canónico');

  // ── period en /api/payments ──
  r = await j('/api/payments?period=today', { headers: A.H });
  ok(r.status === 200 && r.body.from === today && r.body.to === today, 'period=today resuelve from/to');
  const dd = (d, k) => new Date(Date.parse(d) + k * 86400000).toISOString().slice(0, 10);
  r = await j('/api/payments?period=yesterday', { headers: A.H });
  ok(r.body.from === dd(today, -1) && r.body.to === dd(today, -1), 'period=yesterday');
  r = await j('/api/payments?period=7d', { headers: A.H });
  ok(r.body.from === dd(today, -6) && r.body.to === today, 'period=7d');
  r = await j('/api/payments?period=month', { headers: A.H });
  ok(r.body.from === today.slice(0, 8) + '01' && r.body.to === today, 'period=month');
  r = await j('/api/payments?period=today&from=2026-01-15&to=2026-01-15', { headers: A.H });
  ok(r.body.from === '2026-01-15' && r.body.payments.length === 1, 'from/to mandan sobre period');
  ok((await j('/api/payments?period=forever', { headers: A.H })).status === 400, 'period inválido → 400');

  // ── Mensajes ──
  r = await send(A.H, 'PATCH', '/api/orders/' + o1.id, { pay_status: 'ok' });
  ok(r.status === 400 && /Registrar pago/.test(r.body.error), 'PATCH con pay_status → 400 con aviso de recargar');

  // ── Demos ──
  const adm = await adminToken();
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm, 'X-Demo-Key': DEMO_KEY };
  const email = 'demopagos' + Date.now() + '@test.local';
  const demo = (await j('/api/admin/demos', { method: 'POST', headers: AH, body: JSON.stringify({ email, businessName: 'Demo Pagos', days: 3, sendEmail: false }) })).body;
  const dl = (await j('/api/tenant/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: demo.password }) })).body;
  const DH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dl.token };
  clearMeta();
  const dOrders = (await j('/api/orders', { headers: DH })).body;
  const st = s => dOrders.filter(o => o.payStatus === s).length;
  ok(st('ok') > 0 && st('partial') > 0 && st('pend') > 0, `Demo: pedidos pagados (${st('ok')}), abonados (${st('partial')}) y sin cobrar (${st('pend')})`);
  ok(dOrders.every(o => (o.payStatus === 'ok') === (o.balance === 0) && o.amountPaid <= Number(o.totalPrice)), 'Demo: estado, cobrado y saldo coherentes');
  const dbDemo = (await db.query(`
    SELECT COUNT(*)::int bad FROM orders o WHERE tenant_id=$1 AND amount_paid <> COALESCE((SELECT SUM(amount_base) FROM payments p WHERE p.order_id=o.id AND p.voided_at IS NULL),0)`, [demo.tenantId])).rows[0];
  ok(dbDemo.bad === 0, 'Demo: amount_paid = suma de pagos vigentes en todos los pedidos');
  ok(Number((await db.query('SELECT COUNT(*) n FROM payments WHERE tenant_id=$1 AND voided_at IS NOT NULL', [demo.tenantId])).rows[0].n) > 0, 'Demo: incluye un pago anulado');
  ok(Number((await db.query(`SELECT COUNT(DISTINCT type) n FROM order_events WHERE tenant_id=$1`, [demo.tenantId])).rows[0].n) >= 4, 'Demo: historial de ejemplo');
  const dp = dOrders.find(o => o.payStatus === 'pend');
  r = await pay(DH, dp.id, { amount: 10, method: 'Zelle', reference: 'DEMO1' });
  ok(r.status === 200 && r.body.order.payStatus === 'partial', 'Demo: puede registrar pagos');
  r = await post(DH, `/api/payments/${r.body.payment.id}/void`, { reason: 'prueba' });
  ok(r.status === 200 && r.body.order.payStatus === 'pend', 'Demo: puede anular pagos');
  ok((await j(`/api/orders/${dp.id}/events`, { headers: DH })).status === 200, 'Demo: historial del pedido');
  ok((await j(`/api/payments?from=2026-01-01&to=${today}`, { headers: DH })).body.payments.length > 0, 'Demo: listado de cobros');
  ok((await j('/api/tenant/settings', { headers: DH })).status === 200 && (await send(DH, 'PUT', '/api/tenant/settings', { paymentMethods: [{ id: 'z', name: 'Zelle' }] })).status === 200, 'Demo: ajustes de pago');
  ok(metaCalls().length === 0, 'Demo: ninguna llamada a Meta por los pagos');
  await db.query("INSERT INTO order_events (tenant_id, order_id, type) SELECT $1, $2, 'edited' FROM generate_series(1, 5000)", [demo.tenantId, dp.id]);
  r = await pay(DH, dp.id, { amount: 1, method: 'Zelle' });
  ok(r.status === 429 && r.body.error === 'demo_limit', 'Demo: tope de order_events en pagos');
  r = await send(DH, 'PATCH', '/api/orders/' + dp.id, { notes: 'x' });
  ok(r.status === 429, 'Demo: tope de order_events en editar pedido');
  r = await post(DH, '/api/orders', { clientName: 'X', items: [{ name: 'a', qty: 1, unitPrice: 5 }] });
  ok(r.status === 429, 'Demo: tope de order_events al crear pedido');
  r = await post(DH, '/api/payments/' + dp.id + '/void', { reason: 'x' });
  ok(r.status === 429, 'Demo: tope de order_events al anular');
  await db.query("DELETE FROM order_events WHERE tenant_id = $1 AND type = 'edited' AND data IS NULL", [demo.tenantId]);
  await db.query("INSERT INTO payments (tenant_id, order_id, amount, currency, amount_base, method) SELECT $1, $2, 1, 'USD', 1, 'Zelle' FROM generate_series(1, 600)", [demo.tenantId, dp.id]);
  r = await post(DH, '/api/orders', { clientName: 'X', items: [{ name: 'a', qty: 1, unitPrice: 5 }], initialPayment: { amount: 1, method: 'Zelle' } });
  ok(r.status === 429, 'Demo: tope de payments con initialPayment');
  r = await j('/api/admin/demos/' + demo.tenantId + '/convert', { method: 'POST', headers: AH });
  ok(r.status === 200, 'Demo convertida en real');
  const left = (await db.query(`SELECT (SELECT COUNT(*) FROM payments WHERE tenant_id=$1)::int p, (SELECT COUNT(*) FROM order_events WHERE tenant_id=$1)::int e, (SELECT COUNT(*) FROM tenant_settings WHERE tenant_id=$1)::int s`, [demo.tenantId])).rows[0];
  ok(left.p === 0 && left.e === 0 && left.s === 0, '"Hacer real" borra pagos, historial y ajustes de la demo');

  await db.end();
});
