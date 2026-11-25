// Fase 3 (1/2): presupuestos, estados, anulación, impuesto, fecha y zona de entrega.
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, run } = require('../helpers/harness');
const post = (H, u, b) => send(H, 'POST', u, b);
const patch = (H, u, b) => send(H, 'PATCH', u, b);
const put = (H, u, b) => send(H, 'PUT', u, b);
const TZ = 'America/Caracas';

run(async () => {
  const db = await dbConnect();
  const A = await reg('Ciclo A');
  await db.query('UPDATE tenants SET timezone=$1, plan=$2 WHERE id=$3', [TZ, 'pro', A.id]);
  const mk = (H, extra = {}) => post(H, '/api/orders', { clientName: 'Cliente Uno', items: [{ name: 'Camisa', qty: 2, unitPrice: 50 }], ...extra });
  const pay = (H, id, b) => post(H, `/api/orders/${id}/payments`, b);
  const get = (H, u) => j(u, { headers: H });
  const report = async () => (await get(A.H, '/api/reports?period=hoy&tz=' + TZ)).body;

  // ── Presupuestos ──
  const base0 = await report();
  let r = await mk(A.H, { kind: 'quote' });
  const q1 = r.body;
  ok(r.status === 200 && q1.kind === 'quote' && q1.orderNumber === 'P-0001' && q1.totalPrice == 100, 'Presupuesto: creado como P-0001');
  const dbq = (await db.query('SELECT tenant_order_number, quote_number, kind FROM orders WHERE id=$1', [q1.id])).rows[0];
  ok(dbq.tenant_order_number === null && dbq.quote_number === 1 && dbq.kind === 'quote', 'Presupuesto: sin número de pedido, con número de presupuesto');
  r = await mk(A.H);
  const o1 = r.body;
  ok(r.status === 200 && o1.kind === 'order' && o1.orderNumber === '#0001', 'La numeración de pedidos es independiente (#0001)');
  r = await mk(A.H, { kind: 'quote' });
  const q2 = r.body;
  ok(q2.orderNumber === 'P-0002', 'El segundo presupuesto es P-0002');
  r = await mk(A.H, { kind: 'cosa' });
  ok(r.status === 400, 'Tipo de documento inválido → 400');
  r = await mk(A.H, { kind: 'quote', initialPayment: { amount: 10, method: 'Efectivo' } });
  ok(r.status === 400 && /presupuesto/i.test(r.body.error), 'Presupuesto con cobro inicial → 400');
  r = await pay(A.H, q1.id, { amount: 10, method: 'Efectivo' });
  ok(r.status === 400, 'Un presupuesto no admite pagos');
  r = await post(A.H, `/api/orders/${q1.id}/returns`, { amount: 10, reason: 'x', resolution: 'credit' });
  ok(r.status === 400, 'Un presupuesto no admite devoluciones');
  const rep1 = await report();
  ok(rep1.ventas === base0.ventas + 100 && rep1.pedidos === base0.pedidos + 1, 'Informes: los presupuestos no cuentan (solo el pedido #0001)');
  const cl = (await get(A.H, '/api/clients')).body.find(c => c.id === q1.clientId);
  ok(cl.balance === 100, 'Saldo del cliente: solo cuenta el pedido, no los presupuestos (100)');

  // Convertir
  r = await post(A.H, `/api/orders/${q1.id}/convert`, {});
  ok(r.status === 200 && r.body.order.kind === 'order' && r.body.order.orderNumber === '#0002', 'Convertir: P-0001 pasa a ser el pedido #0002');
  r = await post(A.H, `/api/orders/${q1.id}/convert`, {});
  ok(r.status === 400, 'Convertir un pedido ya convertido → 400');
  const ev = (await get(A.H, `/api/orders/${q1.id}/events`)).body.events.map(e => e.type);
  ok(ev.includes('converted'), 'Historial: evento converted');
  const rep2 = await report();
  ok(rep2.pedidos === base0.pedidos + 2 && rep2.ventas === base0.ventas + 200, 'Informes: tras convertir, el pedido sí cuenta');
  r = await pay(A.H, q1.id, { amount: 10, method: 'Efectivo' });
  ok(r.status === 200, 'Ya convertido, admite pagos');
  r = await mk(A.H);
  ok(r.body.orderNumber === '#0003', 'El siguiente pedido es #0003 (el contador sigue)');
  // anular un presupuesto: sin dinero
  r = await post(A.H, `/api/orders/${q2.id}/cancel`, {});
  ok(r.status === 400, 'Anular sin motivo → 400');
  r = await post(A.H, `/api/orders/${q2.id}/cancel`, { reason: 'El cliente no respondió' });
  ok(r.status === 200 && r.body.order.cancelled === true, 'Un presupuesto se puede anular (sin dinero)');
  r = await post(A.H, `/api/orders/${q2.id}/convert`, {});
  ok(r.status === 400, 'Un presupuesto anulado no se convierte');

  // ── Estados de entrega ──
  const s1 = (await mk(A.H)).body;
  for (const st of ['preparing', 'on_the_way', 'delivered', 'not_delivered', 'to_deliver']) {
    r = await patch(A.H, `/api/orders/${s1.id}`, { delivery_status: st });
    ok(r.status === 200 && r.body.deliveryStatus === st, 'Estado ' + st);
  }
  r = await patch(A.H, `/api/orders/${s1.id}`, { delivery_status: 'volando' });
  ok(r.status === 400, 'Estado inventado → 400');
  r = await patch(A.H, `/api/orders/${s1.id}`, { delivery_status: 'cancelled' });
  ok(r.status === 400 && /Anular/.test(r.body.error), 'PATCH no puede poner «cancelled»');
  r = await mk(A.H, { deliveryStatus: 'cancelled' });
  ok(r.status === 400, 'Crear un pedido ya anulado → 400');
  r = await mk(A.H, { deliveryStatus: 'on_the_way' });
  ok(r.status === 200 && r.body.deliveryStatus === 'on_the_way', 'Crear con estado En camino');
  ok((await get(A.H, `/api/orders/${s1.id}/events`)).body.events.filter(e => e.type === 'status_changed').length === 5, 'Historial: 5 cambios de estado');
  const rep3 = await report();
  ok(rep3.pendientes >= 2, 'Informes: Preparando / En camino cuentan como pendientes de entrega');

  // ── Anular con dinero ──
  const c1 = (await mk(A.H, { clientName: 'Ana Anulada' })).body;
  await pay(A.H, c1.id, { amount: 100, method: 'Efectivo' });
  r = await post(A.H, `/api/orders/${c1.id}/cancel`, { reason: 'Se arrepintió' });
  ok(r.status === 400, 'Anular un pedido cobrado sin decir qué hacer con el dinero → 400');
  r = await post(A.H, `/api/orders/${c1.id}/cancel`, { reason: 'Se arrepintió', resolution: 'refund' });
  ok(r.status === 400, 'Reembolsar sin método → 400');
  r = await post(A.H, `/api/orders/${c1.id}/cancel`, { reason: 'x'.repeat(301), resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400, 'Motivo de más de 300 caracteres → 400');
  const balBefore = (await report()).ventas;
  r = await post(A.H, `/api/orders/${c1.id}/cancel`, { reason: 'Se arrepintió', resolution: 'refund', refundMethod: 'efectivo $' });
  ok(r.status === 200 && r.body.order.cancelled && r.body.order.deliveryStatus === 'cancelled' && r.body.order.cancelReason === 'Se arrepintió', 'Anulado con reembolso');
  ok(r.body.order.amountPaid === 0 && r.body.order.balance === 0, 'Lo cobrado neto vuelve a 0 y no queda saldo');
  let rr = (await get(A.H, `/api/orders/${c1.id}/returns`)).body;
  ok(rr.refunds.length === 1 && rr.refunds[0].amountBase === 100 && rr.refunds[0].method === 'Efectivo', 'Un reembolso de 100 con el método canónico');
  const evs = (await get(A.H, `/api/orders/${c1.id}/events`)).body.events.map(e => e.type);
  ok(evs.includes('cancelled') && evs.includes('refunded'), 'Historial: cancelled y refunded');
  ok((await report()).ventas === balBefore - 100, 'Ventas: el pedido anulado sale de las ventas');
  r = await post(A.H, `/api/orders/${c1.id}/cancel`, { reason: 'otra vez', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400, 'Anular dos veces → 400');
  r = await patch(A.H, `/api/orders/${c1.id}`, { notes: 'hola' });
  ok(r.status === 400, 'PATCH sobre un pedido anulado → 400');
  r = await pay(A.H, c1.id, { amount: 5, method: 'Efectivo' });
  ok(r.status === 400, 'Pagar un pedido anulado → 400');
  r = await post(A.H, `/api/orders/${c1.id}/returns`, { amount: 5, reason: 'x', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400, 'Devolver sobre un pedido anulado → 400');

  // anular y dejar saldo a favor
  const c2 = (await mk(A.H, { clientName: 'Beto Saldo' })).body;
  await pay(A.H, c2.id, { amount: 60, method: 'Zelle' });
  r = await post(A.H, `/api/orders/${c2.id}/cancel`, { reason: 'Sin stock', resolution: 'credit' });
  ok(r.status === 200 && r.body.order.amountPaid === 0, 'Anulado con saldo a favor');
  let cr = (await get(A.H, `/api/clients/${c2.clientId}/credit`)).body;
  ok(cr.balance === 60 && cr.entries.length === 1 && cr.entries[0].kind === 'refund_to_credit' && cr.entries[0].amount === 60, 'El cliente queda con 60 a favor');
  rr = (await get(A.H, `/api/orders/${c2.id}/returns`)).body;
  ok(rr.refunds.length === 1 && rr.refunds[0].method === 'Saldo a favor', 'El reembolso queda como método «Saldo a favor»');
  const cl2 = (await get(A.H, '/api/clients')).body.find(c => c.id === c2.clientId);
  ok(cl2.credit === 60 && cl2.balance === 0, 'La ficha trae credit 60 y balance 0 (anulado fuera del saldo)');
  // sin ficha de cliente + saldo a favor → 400
  const c3 = (await mk(A.H, { clientName: 'Sin Ficha' })).body;
  await pay(A.H, c3.id, { amount: 50, method: 'Efectivo' });
  r = await patch(A.H, `/api/orders/${c3.id}`, { client_id: null });
  ok(r.status === 200 && r.body.clientId === null, 'Pedido sin ficha');
  r = await post(A.H, `/api/orders/${c3.id}/cancel`, { reason: 'Prueba', resolution: 'credit' });
  ok(r.status === 400 && /cliente/i.test(r.body.error), 'Anular con saldo a favor sin cliente → 400');
  ok((await get(A.H, `/api/orders/${c3.id}`)).status !== 500, 'Nada se rompió');
  r = await post(A.H, `/api/orders/${c3.id}/cancel`, { reason: 'Prueba', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200, 'El mismo pedido sí se anula con reembolso');
  // sin dinero: no hace falta elegir
  const c4 = (await mk(A.H, { clientName: 'Cero Pagos' })).body;
  r = await post(A.H, `/api/orders/${c4.id}/cancel`, { reason: 'Duplicado' });
  ok(r.status === 200 && r.body.order.cancelled, 'Anular un pedido sin cobros no pide resolución');
  const rep4 = await report();
  ok(rep4.cancelados >= 4, 'Informes: cancelados es el conteo real (' + rep4.cancelados + ')');
  const cl4 = (await get(A.H, '/api/clients')).body.find(c => c.id === c4.clientId);
  ok(cl4.balance === 0, 'Un pedido anulado sin cobrar no cuenta como deuda del cliente');

  // ── Impuesto ──
  const T = await reg('Ciclo Impuesto');
  let s = (await get(T.H, '/api/tenant/settings')).body;
  ok(s.tax && s.tax.enabled === false && s.tax.label === 'IVA' && Array.isArray(s.zones) && s.zones.length === 0 && typeof s.timezone === 'string', 'Ajustes por defecto: impuesto apagado, sin zonas, con zona horaria');
  let t0 = (await mk(T.H, { shipping: 10 })).body;
  ok(t0.taxRate === 0 && t0.taxAmount === 0 && t0.totalPrice == 110, 'Impuesto apagado: total = artículos + envío');
  for (const bad of [{ enabled: true, rate: 101 }, { enabled: true, rate: -1 }, { enabled: 'si', rate: 5 }, { enabled: true, rate: 5, label: 'x'.repeat(31) },
    { enabled: true }, { enabled: true, rate: 5, extra: 1 }, 'IVA', { enabled: true, rate: 'abc' }]) {
    r = await put(T.H, '/api/tenant/settings', { tax: bad });
    ok(r.status === 400, 'Impuesto inválido → 400 ' + JSON.stringify(bad));
  }
  r = await put(T.H, '/api/tenant/settings', { tax: { enabled: true, rate: 16, label: ' IVA ' } });
  ok(r.status === 200 && r.body.tax.enabled && r.body.tax.rate === 16 && r.body.tax.label === 'IVA', 'Impuesto encendido al 16 %');
  const t1 = (await mk(T.H, { items: [{ name: 'Mesa', qty: 1, unitPrice: 100 }], shipping: 10, discount: 20 })).body;
  ok(t1.taxRate === 16 && t1.taxAmount === 12.8 && t1.subtotal === 100 && Number(t1.totalPrice) === 102.8, 'Total = 100 − 20 + IVA 12.80 + envío 10 = 102.80');
  const dbt = (await db.query('SELECT tax_rate, tax_amount FROM orders WHERE id=$1', [t1.id])).rows[0];
  ok(Number(dbt.tax_rate) === 16 && Number(dbt.tax_amount) === 12.8, 'La foto del impuesto queda en el pedido');
  const t2 = (await mk(T.H, { items: [{ name: 'Mesa', qty: 3, unitPrice: 11.11 }] })).body;
  ok(t2.taxAmount === 5.33 && Number(t2.totalPrice) === 38.66, 'Redondeo a 2 decimales (33.33 × 16 % = 5.33)');
  const tq = (await mk(T.H, { kind: 'quote', items: [{ name: 'Mesa', qty: 1, unitPrice: 50 }] })).body;
  ok(tq.taxRate === 16 && Number(tq.totalPrice) === 58, 'El presupuesto también guarda su impuesto');
  r = await put(T.H, '/api/tenant/settings', { tax: { enabled: false, rate: 16, label: 'IVA' } });
  ok(r.status === 200 && r.body.tax.enabled === false, 'Impuesto apagado de nuevo');
  r = await patch(T.H, `/api/orders/${t1.id}`, { shipping: 20 });
  ok(r.status === 200 && r.body.taxRate === 16 && r.body.taxAmount === 12.8 && Number(r.body.totalPrice) === 112.8, 'Al editar se usa la tasa PROPIA del pedido (16 %), no el ajuste actual');
  r = await patch(T.H, `/api/orders/${t1.id}`, { items: [{ name: 'Mesa', qty: 2, unitPrice: 100 }] });
  ok(r.status === 200 && r.body.taxAmount === 28.8 && Number(r.body.totalPrice) === 228.8, 'Editar artículos recalcula el impuesto con la tasa del pedido');
  const t3 = (await mk(T.H, { items: [{ name: 'Mesa', qty: 1, unitPrice: 100 }] })).body;
  ok(t3.taxRate === 0 && Number(t3.totalPrice) === 100, 'Un pedido nuevo con el impuesto apagado no lleva IVA');
  r = await mk(T.H, { items: [{ name: 'Mesa', qty: 1, unitPrice: 10 }], discount: 50 });
  ok(r.status === 400, 'Descuento mayor que el total → 400');
  const t4 = (await mk(T.H, { items: [{ name: 'Mesa', qty: 1, unitPrice: 10 }], shipping: 30, discount: 20 })).body;
  ok(Number(t4.totalPrice) === 20 && t4.taxAmount === 0, 'Descuento mayor que los artículos pero cubierto por el envío: base 0, sin impuesto');
  ok(t0.taxRate === 0 && (await get(T.H, '/api/orders')).body.find(o => o.id === t0.id).taxRate === 0, 'Los pedidos anteriores quedan con impuesto 0');

  // ── Fecha de entrega y zona ──
  const z1 = (await mk(T.H, { deliveryDate: '2026-12-05', deliveryZone: ' Centro ' })).body;
  ok(z1.deliveryDate === '2026-12-05' && z1.deliveryZone === 'Centro', 'Fecha y zona guardadas (fecha sin desfase de zona horaria)');
  ok((await get(T.H, '/api/orders')).body.find(o => o.id === z1.id).deliveryDate === '2026-12-05', 'La lista también devuelve la fecha tal cual');
  for (const d of ['2026-02-31', '2026-13-01', 'mañana', '05/12/2026', '1999-01-01']) {
    r = await mk(T.H, { deliveryDate: d });
    ok(r.status === 400, 'Fecha de entrega inválida (' + d + ') → 400');
  }
  r = await mk(T.H, { deliveryZone: 'z'.repeat(61) });
  ok(r.status === 400, 'Zona de más de 60 caracteres → 400');
  r = await patch(T.H, `/api/orders/${z1.id}`, { delivery_date: '2026-12-06', delivery_zone: 'Norte' });
  ok(r.status === 200 && r.body.deliveryDate === '2026-12-06' && r.body.deliveryZone === 'Norte', 'Editar fecha y zona');
  r = await patch(T.H, `/api/orders/${z1.id}`, { delivery_date: '2026-02-30' });
  ok(r.status === 400, 'Editar con fecha inválida → 400');
  r = await patch(T.H, `/api/orders/${z1.id}`, { delivery_date: null, delivery_zone: null });
  ok(r.status === 200 && r.body.deliveryDate === null && r.body.deliveryZone === null, 'Quitar la fecha y la zona');
  // zonas del negocio
  r = await put(T.H, '/api/tenant/settings', { zones: [{ name: 'Centro', cost: 3 }, { name: ' Norte ' }, { name: 'Este', cost: '4.555' }] });
  ok(r.status === 200 && r.body.zones.length === 3 && r.body.zones[1].name === 'Norte' && r.body.zones[1].cost === undefined && r.body.zones[2].cost === 4.56, 'Zonas guardadas (costo opcional)');
  s = (await get(T.H, '/api/tenant/settings')).body;
  ok(s.zones.length === 3 && s.zones[0].cost === 3, 'GET ajustes devuelve las zonas');
  for (const bad of [[{ name: '' }], [{ name: 'x'.repeat(61) }], [{ name: 'A', cost: -1 }], [{ name: 'A' }, { name: 'a' }],
    Array.from({ length: 51 }, (_, i) => ({ name: 'Z' + i })), 'Centro', [{ name: 'A', otra: 1 }]]) {
    r = await put(T.H, '/api/tenant/settings', { zones: bad });
    ok(r.status === 400, 'Zonas inválidas → 400');
  }
  r = await put(T.H, '/api/tenant/settings', { zones: Array.from({ length: 50 }, (_, i) => ({ name: 'Z' + i, cost: i })) });
  ok(r.status === 200 && r.body.zones.length === 50, 'Hasta 50 zonas');
  r = await put(T.H, '/api/tenant/settings', { zones: [] });
  ok(r.status === 200 && r.body.zones.length === 0, 'Se pueden vaciar');
  // el ajuste de impuesto no pisa los demás y viceversa
  await put(T.H, '/api/tenant/settings', { tax: { enabled: true, rate: 7.5, label: 'ITBMS' } });
  s = (await get(T.H, '/api/tenant/settings')).body;
  ok(s.tax.label === 'ITBMS' && s.tax.rate === 7.5 && Array.isArray(s.paymentMethods), 'Cambiar el impuesto no borra lo demás');

  await db.end();
});
