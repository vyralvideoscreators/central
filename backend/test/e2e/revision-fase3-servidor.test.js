// Revisión de la Fase 3 (servidor): saldo de la ficha, borrado de clientes, cambio de cliente con saldo a favor,
// total con notas de crédito, céntimos en devoluciones por artículos, topes y límites de demo, índices y CHECK.
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const post = (H, u, b) => send(H, 'POST', u, b);
const patch = (H, u, b) => send(H, 'PATCH', u, b);
const put = (H, u, b) => send(H, 'PUT', u, b);
const del = (H, u) => send(H, 'DELETE', u);
const TZ = 'America/Caracas';
const cents = (n) => Math.round(Number(n) * 100);

run(async () => {
  const db = await dbConnect();
  const A = await reg('Rev3 A');
  await db.query('UPDATE tenants SET timezone=$1, plan=$2 WHERE id=$3', [TZ, 'pro', A.id]);
  const get = (H, u) => j(u, { headers: H });
  const pay = (H, id, b) => post(H, `/api/orders/${id}/payments`, b);
  const ret = (H, id, b) => post(H, `/api/orders/${id}/returns`, b);
  const mkClient = async (H, name) => (await post(H, '/api/clients', { name })).body;
  const mkOrder = (H, clientId, total, extra = {}) =>
    post(H, '/api/orders', { clientName: 'X', clientId, items: [{ name: 'Art', qty: 1, unitPrice: total }], ...extra }).then(r => r.body);
  const clientRow = async (H, id) => (await get(H, '/api/clients')).body.find(c => c.id === id);
  const creditOf = async (H, id) => (await get(H, `/api/clients/${id}/credit`)).body.balance;

  // ── 3. Esquema: índices nuevos, sin redundantes ni el de delivery_date; CHECK validado después de listen ──
  const idx = (await db.query(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public'`)).rows;
  const idxDef = (n) => (idx.find(i => i.indexname === n) || {}).indexdef || '';
  ok(/\(tenant_id, client_id\) INCLUDE \(amount\)/.test(idxDef('client_credit_tenant_client_idx')), 'Índice (tenant_id, client_id) INCLUDE (amount) en client_credit_entries');
  ok(!idxDef('client_credit_client_idx') && !idxDef('client_credit_tenant_idx'), 'Sin los índices redundantes de client_credit_entries');
  ok(/WHERE \(order_id IS NOT NULL\)/.test(idxDef('client_credit_order_idx')), 'Índice parcial client_credit_entries (order_id)');
  ok(/WHERE \(credit_note_id IS NOT NULL\)/.test(idxDef('refunds_credit_note_idx')), 'Índice parcial refunds (credit_note_id)');
  ok(/WHERE \(client_id IS NOT NULL\)/.test(idxDef('credit_notes_client_idx')), 'Índice parcial credit_notes (client_id)');
  ok(!idxDef('orders_tenant_delivery_date_idx'), 'Ya no hay índice por delivery_date (nadie filtra por esa columna)');
  let validated = false;
  for (let i = 0; i < 20 && !validated; i++) {
    const c = (await db.query(`SELECT convalidated FROM pg_constraint WHERE conname='orders_kind_check' AND conrelid=to_regclass('public.orders')`)).rows[0];
    validated = !!(c && c.convalidated);
    if (!validated) await new Promise(r => setTimeout(r, 250));
  }
  ok(validated, 'El CHECK orders_kind_check existe y se valida en segundo plano tras listen');

  // ── 4. La ficha editada trae el MISMO saldo que la lista ──
  const cx = await mkClient(A.H, 'Saldo Común');
  const oa = await mkOrder(A.H, cx.id, 100);                       // 100 por cobrar
  await ret(A.H, oa.id, { amount: 30, reason: 'Descuento posterior', resolution: 'refund', refundMethod: 'Efectivo' }); // efectivo 70
  const ob = await mkOrder(A.H, cx.id, 50);
  await post(A.H, `/api/orders/${ob.id}/cancel`, { reason: 'No lo quiso' });                                         // anulado: no cuenta
  await mkOrder(A.H, cx.id, 40, { kind: 'quote' });                                                                  // presupuesto: no cuenta
  const oc = await mkOrder(A.H, cx.id, 60);
  await pay(A.H, oc.id, { full: true, method: 'Efectivo' });
  let r = await ret(A.H, oc.id, { amount: 60, reason: 'Devolución total', resolution: 'credit' });                  // saldo a favor 60
  ok(r.status === 200, 'Preparación: devolución dejada como saldo a favor');
  const fromList = await clientRow(A.H, cx.id);
  ok(fromList.balance === 70 && fromList.credit === 60 && fromList.ordersWithBalance === 1, 'Lista: saldo por cobrar 70 (efectivo, sin anulados ni presupuestos) y saldo a favor 60');
  r = await patch(A.H, `/api/clients/${cx.id}`, { name: 'Saldo Común 2' });
  ok(r.status === 200 && r.body.balance === fromList.balance && r.body.credit === fromList.credit && r.body.ordersWithBalance === fromList.ordersWithBalance,
    'PATCH de la ficha: balance, credit y ordersWithBalance iguales a los de la lista');

  // ── 5. Borrar clientes: con saldo a favor no; sin saldo sí; inexistente → 404 ──
  r = await del(A.H, `/api/clients/${cx.id}`);
  ok(r.status === 400 && /saldo a favor/i.test(r.body.error), 'Borrar un cliente con saldo a favor → 400');
  ok((await clientRow(A.H, cx.id)) !== undefined, 'El cliente con saldo sigue existiendo');
  const cy = await mkClient(A.H, 'Sin Saldo');
  r = await del(A.H, `/api/clients/${cy.id}`);
  ok(r.status === 200, 'Borrar un cliente sin saldo');
  r = await del(A.H, `/api/clients/${cy.id}`);
  ok(r.status === 404, 'Borrar otra vez → 404');
  r = await del(A.H, '/api/clients/00000000-0000-4000-8000-000000000000');
  ok(r.status === 404, 'Borrar un id inexistente → 404');
  // un pago con saldo a favor en paralelo con el borrado: el cliente nunca queda borrado con saldo gastado a medias
  const cz = await mkClient(A.H, 'Carrera');
  const oz0 = await mkOrder(A.H, cz.id, 50);
  await pay(A.H, oz0.id, { full: true, method: 'Efectivo' });
  await ret(A.H, oz0.id, { amount: 50, reason: 'x', resolution: 'credit' });
  const oz = await mkOrder(A.H, cz.id, 50);
  const [rp, rd] = await Promise.all([pay(A.H, oz.id, { amount: 50, method: 'Saldo a favor' }), del(A.H, `/api/clients/${cz.id}`)]);
  const stillThere = (await db.query('SELECT 1 FROM clients WHERE id=$1', [cz.id])).rows.length === 1;
  // Si el borrado va primero, ve el saldo (50) y se rechaza; si va después del pago, el saldo ya es 0 y se borra. Nunca se borra con saldo.
  ok((rd.status === 400 && stillThere) || (rd.status === 200 && rp.status === 200 && !stillThere),
    'Pago con saldo y borrado a la vez: resultado coherente (' + rp.status + '/' + rd.status + ')');
  ok(Number((await db.query('SELECT COALESCE(SUM(amount),0) s FROM client_credit_entries WHERE client_id=$1', [cz.id])).rows[0].s) >= 0, 'Saldo nunca negativo tras la carrera');

  // ── 6. Cambio de cliente con saldo a favor o devoluciones ──
  const cp = await mkClient(A.H, 'Cliente P'), cq = await mkClient(A.H, 'Cliente Q');
  const p0 = await mkOrder(A.H, cp.id, 100);
  await pay(A.H, p0.id, { full: true, method: 'Efectivo' });
  await ret(A.H, p0.id, { amount: 100, reason: 'Todo', resolution: 'credit' }); // P: saldo 100
  r = await patch(A.H, `/api/orders/${p0.id}`, { client_id: cq.id });
  ok(r.status === 400 && /cambiar de cliente/i.test(r.body.error), 'Pedido con notas de crédito: no se puede cambiar de cliente');
  const p1 = await mkOrder(A.H, cp.id, 60);
  await pay(A.H, p1.id, { amount: 20, method: 'Saldo a favor' });
  r = await patch(A.H, `/api/orders/${p1.id}`, { client_id: cq.id });
  ok(r.status === 400 && /cambiar de cliente/i.test(r.body.error), 'Pedido pagado con saldo a favor: no se puede cambiar de cliente');
  r = await patch(A.H, `/api/orders/${p1.id}`, { client_id: cp.id, notes: 'mismo cliente' });
  ok(r.status === 200, 'Enviar el mismo client_id sí se admite');
  const p2 = await mkOrder(A.H, cp.id, 30);
  r = await patch(A.H, `/api/orders/${p2.id}`, { client_id: cq.id });
  ok(r.status === 200 && r.body.clientId === cq.id, 'Un pedido normal sí cambia de cliente');
  r = await patch(A.H, `/api/orders/${p2.id}`, { client_id: null });
  ok(r.status === 200 && !r.body.clientId, 'Y se puede dejar sin ficha');
  // pago con saldo a favor ANULADO: ya no ata al pedido
  const p3 = await mkOrder(A.H, cp.id, 30);
  const pp = (await pay(A.H, p3.id, { amount: 10, method: 'Saldo a favor' })).body.payment;
  await post(A.H, `/api/payments/${pp.id}/void`, { reason: 'error' });
  const hadEntries = Number((await db.query('SELECT COUNT(*) n FROM client_credit_entries WHERE order_id=$1', [p3.id])).rows[0].n);
  r = await patch(A.H, `/api/orders/${p3.id}`, { client_id: cq.id });
  ok(hadEntries === 2 && r.status === 400, 'Con movimientos de saldo registrados (aunque el pago se anulara) tampoco se cambia de cliente');
  // defensa en settleRefundTx: aunque el client_id se alterase por fuera, el saldo vuelve a quien pagó con él
  const p4 = await mkOrder(A.H, cp.id, 40);
  await pay(A.H, p4.id, { full: true, method: 'Saldo a favor' });
  const creditP0 = await creditOf(A.H, cp.id), creditQ0 = await creditOf(A.H, cq.id);
  await db.query('UPDATE orders SET client_id=$1 WHERE id=$2', [cq.id, p4.id]);
  r = await post(A.H, `/api/orders/${p4.id}/cancel`, { reason: 'Defensa', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200 && await creditOf(A.H, cp.id) === creditP0 + 40 && await creditOf(A.H, cq.id) === creditQ0,
    'Anular un pedido pagado con saldo: el saldo vuelve al cliente que pagó con él, no al actual del pedido');

  // ── 7. Total negativo: con notas de crédito el total no se toca ──
  const n0 = (await post(A.H, '/api/orders', { clientName: 'Sin artículos', totalPrice: 100 })).body;
  ok(Number(n0.totalPrice) === 100 && n0.items.length === 0, 'Pedido sin artículos de 100');
  r = await ret(A.H, n0.id, { amount: 40, reason: 'Ajuste', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200 && r.body.order.effectiveTotal === 60, 'Devolución por importe de 40: efectivo 60');
  for (const t of [30, 39.99, 120]) {
    r = await patch(A.H, `/api/orders/${n0.id}`, { total_price: t });
    ok(r.status === 400 && /devoluciones/.test(r.body.error), `PATCH total_price ${t} con notas de crédito → 400`);
  }
  r = await patch(A.H, `/api/orders/${n0.id}`, { total_price: 100, notes: 'mismo total' });
  ok(r.status === 200 && r.body.effectiveTotal === 60, 'Enviar el mismo total no molesta');
  ok((await db.query('SELECT total_price, credited_total FROM orders WHERE id=$1', [n0.id])).rows[0].total_price == 100, 'El total guardado sigue en 100');

  // ── 8. Céntimos en devoluciones por artículos (5+ líneas, impuesto y descuento) ──
  const T = await reg('Rev3 Céntimos');
  await put(T.H, '/api/tenant/settings', { tax: { enabled: true, rate: 16, label: 'IVA' } });
  const LINES = [['Uno', 3, 9.99], ['Dos', 2, 4.37], ['Tres', 1, 7.13], ['Cuatro', 4, 12.49], ['Cinco', 7, 3.07], ['Seis', 3, 1.11]];
  const mkMany = async (shipping, discount) => (await post(T.H, '/api/orders', {
    clientName: 'Céntimos', shipping, discount, items: LINES.map(([name, qty, unitPrice]) => ({ name, qty, unitPrice })) })).body;
  const unitsAll = (o) => o.items.flatMap(it => Array.from({ length: it.qty }, () => ({ orderItemId: it.id, qty: 1 })));
  // (a) devolver todo de una vez
  let m = await mkMany(3.33, 7.77);
  ok(m.items.length === 6 && m.taxRate === 16, 'Pedido de 6 líneas con IVA 16 %, envío 3.33 y descuento 7.77');
  r = await ret(T.H, m.id, { items: m.items.map(it => ({ orderItemId: it.id, qty: it.qty })), reason: 'Todo', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200 && r.body.order.effectiveTotal === 3.33, 'Todo en una nota: el total efectivo queda EXACTAMENTE en el envío (3.33)');
  ok(r.body.creditNote.items.reduce((a, i) => a + cents(i.amount), 0) === cents(r.body.creditNote.amountBase), 'Las líneas de la nota suman el importe de la nota');
  // (b) una unidad por nota (20 notas): nunca supera lo que queda, y la última cierra exacto
  m = await mkMany(3.33, 7.77);
  let allOk = true, last = null, minLeft = Infinity;
  const units = unitsAll(m);
  for (let i = 0; i < units.length; i++) {
    r = await ret(T.H, m.id, { items: [units[i]], reason: 'Una', resolution: 'refund', refundMethod: 'Efectivo' });
    if (r.status !== 200) { allOk = false; last = r; break; }
    minLeft = Math.min(minLeft, cents(r.body.order.effectiveTotal));
    last = r;
  }
  ok(allOk && units.length === 20, 'Devolver las 20 unidades de una en una (20 notas) → 200 cada una' + (allOk ? '' : ' ' + JSON.stringify(last.body)));
  ok(minLeft >= 333 && cents(last.body.order.effectiveTotal) === 333, 'Ninguna nota pasa al envío y la última deja el total efectivo en 3.33 (mínimo visto ' + minLeft / 100 + ')');
  r = await ret(T.H, m.id, { items: [units[0]], reason: 'Otra', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400, 'Sin unidades por devolver → 400');
  // (c) envío devuelto por importe al final → 0 exacto
  r = await ret(T.H, m.id, { amount: 3.33, reason: 'Envío', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200 && r.body.order.effectiveTotal === 0, 'Envío devuelto por importe: total efectivo 0');
  // (d) envío devuelto por importe ANTES de los artículos: los artículos cierran en 0
  m = await mkMany(3.33, 7.77);
  r = await ret(T.H, m.id, { amount: 3.33, reason: 'Envío primero', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200, 'Envío devuelto primero por importe');
  const half = m.items.slice(0, 3).map(it => ({ orderItemId: it.id, qty: it.qty })), rest = m.items.slice(3).map(it => ({ orderItemId: it.id, qty: it.qty }));
  r = await ret(T.H, m.id, { items: half, reason: 'Mitad', resolution: 'refund', refundMethod: 'Efectivo' });
  const mid = r.status === 200 ? cents(r.body.order.effectiveTotal) : -1;
  r = await ret(T.H, m.id, { items: rest, reason: 'Resto', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(mid > 0 && r.status === 200 && r.body.order.effectiveTotal === 0, 'Envío primero y artículos en dos notas: total efectivo 0 exacto (medio: ' + mid / 100 + ')');
  // (e) sin envío ni descuento, con impuesto
  m = await post(T.H, '/api/orders', { clientName: 'Sin envío', items: LINES.map(([name, qty, unitPrice]) => ({ name, qty, unitPrice })) }).then(x => x.body);
  r = await ret(T.H, m.id, { items: m.items.map(it => ({ orderItemId: it.id, qty: it.qty })), reason: 'Todo', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200 && r.body.order.effectiveTotal === 0, 'Sin envío: devolver todo deja 0');

  // ── 9. Tope de notas por pedido y LIMIT en GET /returns ──
  const big = await mkOrder(A.H, null, 100000);
  await db.query(`INSERT INTO credit_notes (tenant_id, order_id, number, amount_base, reason)
    SELECT $1, $2, 9000 + g, 0.01, 'relleno' FROM generate_series(1, 200) g`, [A.id, big.id]);
  r = await ret(A.H, big.id, { amount: 1, reason: 'Una más', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400 && /200/.test(r.body.error), 'Un pedido real con 200 notas no admite más → 400');
  const big2 = await mkOrder(A.H, null, 100000);
  await db.query(`INSERT INTO credit_notes (tenant_id, order_id, number, amount_base, reason)
    SELECT $1, $2, 20000 + g, 0.01, 'relleno' FROM generate_series(1, 600) g`, [A.id, big2.id]);
  r = await get(A.H, `/api/orders/${big2.id}/returns`);
  ok(r.status === 200 && r.body.creditNotes.length === 500, 'GET /returns devuelve como máximo 500 notas (hay 600)');

  // ── 12. Método de reembolso sin cobros previos: se acepta y el informe lo refleja en negativo ──
  const z = await mkOrder(A.H, null, 80);
  await pay(A.H, z.id, { full: true, method: 'Zelle' });
  r = await post(A.H, `/api/orders/${z.id}/cancel`, { reason: 'Prueba método', resolution: 'refund', refundMethod: 'Caja chica' });
  ok(r.status === 200, 'Reembolsar con un método sin cobros en el pedido: aceptado');
  const rep = (await get(A.H, '/api/reports?period=hoy&tz=' + TZ)).body;
  const cj = (rep.cobrosPorMetodo || []).find(m => m[0] === 'Caja Chica');
  ok(cj && cj[1] === -80, 'El informe muestra ese método en negativo (-80): el dinero salió de esa caja');

  // ── 11. cancelados dentro del KPI: mismo resultado ──
  ok(rep.cancelados >= 2 && rep.pedidos >= 1, 'Informe: cancelados salen del KPI (' + rep.cancelados + ') y no cuentan en pedidos');
  const nAll = Number((await db.query(`SELECT COUNT(*) n FROM orders WHERE tenant_id=$1 AND kind='order' AND delivery_status<>'cancelled'`, [A.id])).rows[0].n);
  ok(rep.pedidos === nAll, 'Informe: pedidos = pedidos no anulados en base (' + nAll + ')');

  // ── 10. Demos: límites ──
  const adm = await adminToken();
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm, 'X-Demo-Key': DEMO_KEY };
  const email = 'demorev3' + Date.now() + '@test.local';
  const demo = (await j('/api/admin/demos', { method: 'POST', headers: AH, body: JSON.stringify({ email, businessName: 'Demo Rev3', days: 3, sendEmail: false }) })).body;
  const login = (await j('/api/tenant/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: demo.password }) })).body;
  const D = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  const dClient = (await get(D, '/api/clients')).body[0];
  const ceNow = Number((await db.query('SELECT COUNT(*) n FROM client_credit_entries WHERE tenant_id=$1', [demo.tenantId])).rows[0].n);
  await db.query(`INSERT INTO client_credit_entries (tenant_id, client_id, amount, kind)
    SELECT $1, $2, 0.01, 'refund_to_credit' FROM generate_series(1, $3)`, [demo.tenantId, dClient.id, 600 - ceNow]);
  r = await post(D, '/api/orders', { clientName: 'Demo pago inicial', items: [{ name: 'A', qty: 1, unitPrice: 10 }], initialPayment: { amount: 5, method: 'Efectivo' } });
  ok(r.status === 429 && r.body.error === 'demo_limit', 'Demo: crear un pedido con pago inicial también cuenta el tope de movimientos de saldo a favor');
  r = await post(D, '/api/orders', { clientName: 'Demo sin pago', items: [{ name: 'A', qty: 1, unitPrice: 10 }] });
  ok(r.status === 200, 'Demo: un pedido sin pago inicial no se ve afectado por ese tope');
  await db.query('DELETE FROM client_credit_entries WHERE tenant_id=$1 AND amount=0.01', [demo.tenantId]);
  const note = (await db.query('SELECT id, order_id FROM credit_notes WHERE tenant_id=$1 LIMIT 1', [demo.tenantId])).rows[0];
  const cniNow = Number((await db.query('SELECT COUNT(*) n FROM credit_note_items WHERE tenant_id=$1', [demo.tenantId])).rows[0].n);
  await db.query(`INSERT INTO credit_note_items (tenant_id, credit_note_id, name, qty, amount)
    SELECT $1, $2, 'relleno', 1, 0 FROM generate_series(1, $3)`, [demo.tenantId, note.id, 2000 - cniNow]);
  r = await ret(D, note.order_id, { amount: 1, reason: 'Tope', resolution: 'credit' });
  ok(r.status === 429 && r.body.error === 'demo_limit', 'Demo: tope de 2000 líneas de notas de crédito');
  await db.query('DELETE FROM tenants WHERE id=$1', [demo.tenantId]);

  await db.end();
});
