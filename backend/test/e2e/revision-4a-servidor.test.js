// Revisión de la Fase 4A (servidor): pedido entregado, bloqueos de tenant, existencias en ediciones, moneda base,
// plan de gastos y caja, topes de gasto y existencias, voidedCount, categorías, relleno de pagos y catálogo.
const { ok, j, send, reg, db: dbConnect, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const { backfillLegacyPayments } = require('../../pagos');
const post = (H, u, b) => send(H, 'POST', u, b);
const patch = (H, u, b) => send(H, 'PATCH', u, b);
const put = (H, u, b) => send(H, 'PUT', u, b);
const get = (H, u) => j(u, { headers: H });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const item = (extra = {}) => ({ name: 'Art', qty: 1, unitPrice: 50, ...extra });

run(async () => {
  const db = await dbConnect();
  const A = await reg('Rev4A A'), B = await reg('Rev4A B');
  await db.query("UPDATE tenants SET plan='pro' WHERE id = ANY($1)", [[A.id, B.id]]);
  const newOrder = async (H, total, extra = {}) => (await post(H, '/api/orders', { clientName: 'Cliente', items: [item({ unitPrice: total })], ...extra })).body;
  const pay = (H, id, b) => post(H, `/api/orders/${id}/payments`, b);

  // ═══ C) Un pedido ENTREGADO no se edita ═══
  let o = await newOrder(A.H, 80);
  let r = await patch(A.H, `/api/orders/${o.id}`, { delivery_status: 'delivered' });
  ok(r.status === 200 && r.body.deliveryStatus === 'delivered', 'Marcar el pedido como entregado');
  const NOEDIT = 'Este pedido ya fue entregado: no se puede editar';
  for (const [label, body] of [['dirección', { address: 'Calle 5' }], ['notas', { notes: 'x' }], ['cliente', { client_name: 'Otro' }],
    ['artículos', { items: [item({ qty: 2 })] }], ['total', { total_price: 10 }], ['envío', { shipping: 5 }], ['descuento', { discount: 1 }],
    ['ficha del cliente', { client_id: null }], ['estado + dirección', { delivery_status: 'delivered', address: 'x' }]]) {
    r = await patch(A.H, `/api/orders/${o.id}`, body);
    ok(r.status === 400 && r.body.error === NOEDIT, `Entregado: cambiar ${label} → 400 «${NOEDIT}»`);
  }
  r = await patch(A.H, `/api/orders/${o.id}`, { delivery_status: 'delivered' });
  ok(r.status === 200, 'Repetir el estado «entregado» no es una edición');
  r = await pay(A.H, o.id, { amount: 30, method: 'Efectivo' });
  ok(r.status === 200, 'Un pedido entregado sigue admitiendo cobros');
  r = await patch(A.H, `/api/orders/${o.id}`, { delivery_status: 'to_deliver' });
  ok(r.status === 200 && r.body.deliveryStatus === 'to_deliver', 'Cambiar el estado de un entregado sigue permitido (corregir un «entregado» por error)');
  r = await patch(A.H, `/api/orders/${o.id}`, { address: 'Calle 5' });
  ok(r.status === 200 && r.body.address === 'Calle 5', 'Corregido el estado, el pedido se puede editar de nuevo');
  ok((await db.query('SELECT address FROM orders WHERE id=$1', [o.id])).rows[0].address === 'Calle 5', '… y lo rechazado antes no dejó cambios');

  // ═══ 1) Bloqueo del tenant: FOR KEY SHARE en operaciones de dinero ═══
  // a) Un alta de pedido en curso (UPDATE del contador) NO hace esperar a un cobro
  const o1 = await newOrder(A.H, 100);
  const h1 = await dbConnect();
  await h1.query('BEGIN');
  await h1.query('UPDATE tenants SET order_seq = order_seq WHERE id = $1', [A.id]);
  let t0 = Date.now();
  let res = await Promise.race([pay(A.H, o1.id, { amount: 10, method: 'Efectivo' }), sleep(4000).then(() => null)]);
  const waited = Date.now() - t0;
  await h1.query('COMMIT'); await h1.end();
  ok(res && res.status === 200 && waited < 2500, `Cobro con un alta de pedido abierta: sin esperarla (${waited} ms)`);
  // b) Un cierre de caja en curso (FOR UPDATE) SÍ serializa el cobro: espera y luego entra
  const h2 = await dbConnect();
  await h2.query('BEGIN');
  await h2.query('SELECT 1 FROM tenants WHERE id = $1 FOR UPDATE', [A.id]);
  const pending = pay(A.H, o1.id, { amount: 10, method: 'Efectivo' });
  const early = await Promise.race([pending, sleep(900).then(() => 'esperando')]);
  await h2.query('COMMIT'); await h2.end();
  const late = await pending;
  ok(early === 'esperando' && late.status === 200, 'Cobro con un cierre de caja en curso: espera a que termine y entonces entra');
  // c) Cobros y altas de pedido a la vez: sin errores ni esperas largas
  const many = [];
  for (let i = 0; i < 8; i++) many.push(await newOrder(A.H, 40 + i));
  t0 = Date.now();
  const batch = await Promise.all([
    ...many.map(x => pay(A.H, x.id, { amount: 10, method: 'Zelle' })),
    ...Array.from({ length: 8 }, (_, i) => post(A.H, '/api/orders', { clientName: 'Par ' + i, items: [item()], initialPayment: { amount: 5, method: 'Efectivo' } })),
  ]);
  ok(batch.every(x => x.status === 200) && Date.now() - t0 < 8000, `8 cobros y 8 altas con pago a la vez: todo 200 (${Date.now() - t0} ms)`);
  // d) Anulación mixta (saldo a favor + efectivo) y altas del mismo cliente a la vez
  const base = await newOrder(A.H, 100);
  await pay(A.H, base.id, { amount: 100, method: 'Efectivo' });
  r = await post(A.H, `/api/orders/${base.id}/returns`, { reason: 'Saldo', amount: 40, resolution: 'credit' });
  ok(r.status === 200, 'Cliente con 40 de saldo a favor');
  const clientId = base.clientId;
  for (let round = 1; round <= 3; round++) {
    const ob = await newOrder(A.H, 60, { clientId });
    const p1 = await pay(A.H, ob.id, { amount: 40, method: 'Saldo a favor' }), p2 = await pay(A.H, ob.id, { amount: 20, method: 'Efectivo' });
    if (p1.status !== 200 || p2.status !== 200) { ok(false, `Ronda ${round}: preparar el pedido mixto`); continue; }
    const out = await Promise.all([
      post(A.H, `/api/orders/${ob.id}/cancel`, { reason: 'Mixta', resolution: 'refund', refundMethod: 'Efectivo' }),
      ...Array.from({ length: 4 }, (_, i) => post(A.H, '/api/orders', { clientName: 'Cliente', clientId, items: [item()], initialPayment: i === 0 ? { amount: 5, method: 'Efectivo' } : undefined })),
    ]);
    ok(out.every(x => x.status === 200), `Ronda ${round}: anular (saldo + efectivo) y 4 altas del mismo cliente en paralelo: ningún 500 (${out.map(x => x.status).join(',')})`);
    const cr = (await get(A.H, `/api/clients/${clientId}/credit`)).body;
    ok(cr.balance === 40, `Ronda ${round}: el saldo a favor vuelve a 40 tras anular`);
  }

  // ═══ 2) Existencias: editar sin cambiar artículos NO descuenta ═══
  const colors = [{ name: 'Rojo', hex: '#f00' }, { name: 'Azul', hex: '#00f' }];
  const prodBody = (extra = {}) => ({ name: 'Camisa', price: 20, emoji: '👕', sizes: ['S', 'M'], colors, ...extra });
  const P = (await post(A.H, '/api/catalog', prodBody())).body;
  const line = (qty) => ({ productId: P.id, name: 'Camisa', size: 'S', color: 'Rojo', qty, unitPrice: 20 });
  const so = (await post(A.H, '/api/orders', { clientName: 'Stock', items: [line(2)] })).body;
  ok((await db.query('SELECT COUNT(*)::int n FROM stock_movements WHERE order_id=$1', [so.id])).rows[0].n === 0, 'Pedido creado SIN control de existencias: sin movimientos');
  r = await patch(A.H, `/api/catalog/${P.id}`, prodBody({ trackStock: true }));
  ok(r.status === 200 && r.body.trackStock === true, 'Se activa el control de existencias después');
  const lvl = async (key = 's|rojo') => { const x = await db.query('SELECT qty FROM stock_levels WHERE product_id=$1 AND variant_key=$2', [P.id, key]); return x.rows[0] ? x.rows[0].qty : null; };
  const mv = async () => (await db.query('SELECT reason, delta FROM stock_movements WHERE order_id=$1 ORDER BY created_at, id', [so.id])).rows;
  r = await patch(A.H, `/api/orders/${so.id}`, { address: 'Av. Principal' });
  ok(r.status === 200 && (await mv()).length === 0 && (await lvl()) === null, 'Editar solo la dirección: las existencias no cambian');
  r = await patch(A.H, `/api/orders/${so.id}`, { items: [line(2)] });
  ok(r.status === 200 && (await mv()).length === 0 && (await lvl()) === null, 'Reenviar los mismos artículos: tampoco se mueven');
  r = await patch(A.H, `/api/orders/${so.id}`, { items: [line(3)] });
  ok(r.status === 200 && JSON.stringify(await mv()) === JSON.stringify([{ reason: 'edit', delta: -1 }]) && (await lvl()) === -1, 'Subir de 2 a 3: descuenta SOLO la diferencia (−1)');
  r = await patch(A.H, `/api/orders/${so.id}`, { items: [line(1)] });
  ok(r.status === 200 && (await lvl()) === 0, 'Bajar de 3 a 1: devuelve como máximo lo descontado (+1; el pedido tenía 2 sin descontar)');
  r = await post(A.H, `/api/orders/${so.id}/cancel`, { reason: 'Prueba' });
  ok(r.status === 200 && (await lvl()) === 0, 'Anular devuelve solo lo descontado (nada más)');

  // ═══ 3) La moneda base no se cambia con datos de dinero o costos ═══
  const cleanT = await reg('Moneda limpia');
  r = await get(cleanT.H, '/api/tenant/settings');
  ok(r.body.canChangeBaseCurrency === true, 'Negocio sin datos: la moneda base se puede cambiar');
  const lockCase = async (name, setup) => {
    const T = await reg('Moneda ' + name);
    await db.query("UPDATE tenants SET plan='pro' WHERE id=$1", [T.id]);
    await setup(T);
    const s = await get(T.H, '/api/tenant/settings');
    const c = await put(T.H, '/api/tenant/settings', { baseCurrency: 'EUR' });
    ok(s.body.canChangeBaseCurrency === false && c.status === 400 && /moneda base/.test(c.body.error), `Moneda base fija con ${name}`);
    await db.query('DELETE FROM tenants WHERE id=$1', [T.id]);
  };
  await lockCase('un gasto', async (T) => { await post(T.H, '/api/expenses', { amount: 5, category: 'Otros', method: 'Efectivo' }); });
  await lockCase('un producto con costo', async (T) => { await post(T.H, '/api/catalog', prodBody({ cost: 3 })); });
  await lockCase('un cierre de caja', async (T) => {
    const today = (await get(T.H, '/api/cash/2026-01-01')).body.today;
    await post(T.H, `/api/cash/${today}/close`, { counted: [] });
  });
  await lockCase('un reembolso', async (T) => {
    const x = await newOrder(T.H, 50); await pay(T.H, x.id, { amount: 50, method: 'Efectivo' });
    await post(T.H, `/api/orders/${x.id}/cancel`, { reason: 'r', resolution: 'refund', refundMethod: 'Efectivo' });
    await db.query('DELETE FROM payments WHERE order_id=$1', [x.id]); // solo queda el reembolso
  });
  await lockCase('una línea con costo guardado', async (T) => {
    const x = await newOrder(T.H, 50); await db.query('UPDATE order_items SET unit_cost = 2 WHERE order_id=$1', [x.id]);
  });
  r = await put(cleanT.H, '/api/tenant/settings', { baseCurrency: 'EUR' });
  ok(r.status === 200 && r.body.baseCurrency === 'EUR', 'Sin datos, el cambio de moneda base se guarda');
  await db.query('DELETE FROM tenants WHERE id=$1', [cleanT.id]);

  // ═══ 4) Plan en el servidor: gastos y caja desde Pro ═══
  const Bs = await reg('Plan Básico');
  const uuid = '00000000-0000-4000-8000-000000000000';
  for (const [m, u, b] of [['GET', '/api/expenses'], ['POST', '/api/expenses', { amount: 1, category: 'Otros', method: 'Efectivo' }], ['POST', `/api/expenses/${uuid}/void`, { reason: 'x' }],
    ['GET', '/api/cash'], ['GET', '/api/cash/2026-01-15'], ['POST', '/api/cash/2026-01-15/close', { counted: [] }], ['POST', '/api/cash/2026-01-15/reopen', { reason: 'x' }],
    ['PUT', '/api/tenant/settings', { expenseCategories: ['Una', 'Dos'] }]]) {
    r = await send(Bs.H, m, u, b);
    ok(r.status === 403 && r.body.error === 'plan_required' && typeof r.body.message === 'string', `Básico: ${m} ${u.split('/').slice(0, 3).join('/')} → 403 plan_required`);
  }
  r = await put(Bs.H, '/api/tenant/settings', { zones: [] });
  ok(r.status === 200, 'Básico: el resto de los ajustes se guardan');
  r = await get(Bs.H, '/api/tenant/settings');
  ok(r.status === 200 && Array.isArray(r.body.expenseCategories), 'Básico: GET ajustes sigue funcionando');
  r = await get(A.H, '/api/cash');
  ok(r.status === 200, 'Pro: GET /api/cash → 200');
  r = await get(A.H, '/api/expenses');
  ok(r.status === 200, 'Pro: GET /api/expenses → 200');
  r = await put(A.H, '/api/tenant/settings', { expenseCategories: ['Una', 'Dos'] });
  ok(r.status === 200 && r.body.expenseCategories.join() === 'Una,Dos', 'Pro: las categorías de gastos se guardan');
  await db.query('DELETE FROM tenants WHERE id=$1', [Bs.id]);

  // ═══ 5) Gasto con monto base desbordado → 400 ═══
  r = await post(A.H, '/api/expenses', { amount: 99999999, currency: 'VES', exchangeRate: 0.000001, category: 'Una', method: 'Efectivo' });
  ok(r.status === 400 && /demasiado grande/.test(r.body.error), 'Gasto cuyo monto en base supera el máximo → 400 (no 500)');
  r = await post(A.H, '/api/expenses', { amount: 99999999.99, category: 'Una', method: 'Efectivo' });
  ok(r.status === 200, 'El máximo exacto sí se admite');

  // ═══ 9) voidedCount y categorías sin comas ═══
  const C = await reg('Cat C');
  await db.query("UPDATE tenants SET plan='pro' WHERE id=$1", [C.id]);
  const e1 = (await post(C.H, '/api/expenses', { amount: 3, category: 'Otros', method: 'Efectivo' })).body.expense;
  await post(C.H, '/api/expenses', { amount: 4, category: 'Otros', method: 'Efectivo' });
  const e3 = (await post(C.H, '/api/expenses', { amount: 5, category: 'Envíos', method: 'Efectivo' })).body.expense;
  r = await get(C.H, '/api/expenses');
  ok(r.body.voidedCount === 0 && r.body.totalCount === 3, 'voidedCount = 0 al principio (totalCount 3)');
  await post(C.H, `/api/expenses/${e1.id}/void`, { reason: 'error' }); await post(C.H, `/api/expenses/${e3.id}/void`, { reason: 'error' });
  r = await get(C.H, '/api/expenses');
  ok(r.body.voidedCount === 2 && r.body.totalCount === 3 && r.body.total === 4, 'voidedCount = 2 de 3; el total solo cuenta lo vigente (4)');
  r = await put(C.H, '/api/tenant/settings', { expenseCategories: ['Compras, varias', 'Otros'] });
  ok(r.status === 400 && /comas/.test(r.body.error), 'Una categoría con coma → 400');
  r = await put(C.H, '/api/tenant/settings', { expenseCategories: ['Compras', 'Otros'] });
  ok(r.status === 200, 'Categorías en lista, sin comas: 200');

  // ═══ 6) Existencias: topes, variantes y filas fantasma ═══
  const Q = (await post(A.H, '/api/catalog', prodBody({ name: 'Camisa 2', trackStock: true }))).body;
  const adj = (b) => post(A.H, '/api/stock/adjust', { productId: Q.id, note: 'prueba', ...b });
  r = await adj({ size: 'XL', color: 'Rojo', delta: 1 });
  ok(r.status === 400 && /no existe en este producto/.test(r.body.error), 'Variante que el producto no ofrece → 400');
  r = await adj({ variantKey: '', delta: 1 });
  ok(r.status === 400, 'Un producto con variantes no admite ajustar «sin variante»');
  r = await adj({ size: 'S', color: 'Rojo', count: 0 });
  ok(r.status === 200 && r.body.unchanged === true, 'Contar 0 en una variante que no existía: sin cambios');
  ok((await db.query('SELECT COUNT(*)::int n FROM stock_levels WHERE product_id=$1', [Q.id])).rows[0].n === 0, '… y no deja una fila de existencias fantasma');
  r = await adj({ size: 'S', color: 'Rojo', delta: 5 });
  ok(r.status === 200 && r.body.level === 5, 'Ajuste válido de una variante real: +5');
  await db.query("UPDATE stock_levels SET qty = 9999999 WHERE product_id=$1", [Q.id]);
  r = await adj({ size: 'S', color: 'Rojo', delta: 5 });
  ok(r.status === 400 && /no pueden superar/.test(r.body.error), 'Nivel resultante por encima de 10 000 000 → 400');
  await db.query("UPDATE stock_levels SET qty = -9999999 WHERE product_id=$1", [Q.id]);
  r = await adj({ size: 'S', color: 'Rojo', delta: -5 });
  ok(r.status === 400, 'Nivel resultante por debajo de −10 000 000 → 400');
  r = await adj({ size: 'S', color: 'Rojo', delta: 1000001 });
  ok(r.status === 400, 'Un solo ajuste de más de 1 000 000 → 400 (como antes)');
  const Q2 = (await post(A.H, '/api/catalog', { name: 'Gorra', price: 5, emoji: '🧢', trackStock: true })).body;
  r = await post(A.H, '/api/stock/adjust', { productId: Q2.id, delta: 3, note: 'x' });
  ok(r.status === 200 && r.body.level === 3, 'Un producto sin variantes se ajusta sin talla ni color');

  // ═══ 7) Relleno de pagos antiguos: omite pedidos de un día con la caja cerrada ═══
  const L = await reg('Relleno');
  const lo = await newOrder(L.H, 70);
  await db.query("UPDATE orders SET pay_status='ok', amount_paid=0, created_at = now() - interval '3 days' WHERE id=$1", [lo.id]);
  const lday = (await db.query(`SELECT to_char((created_at AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE 'America/Caracas', 'YYYY-MM-DD') d FROM orders WHERE id=$1`, [lo.id])).rows[0].d;
  await db.query(`INSERT INTO cash_closings (tenant_id, day, expected, counted, difference) VALUES ($1, $2::date, '{}', '{}', '{}')`, [L.id, lday]);
  const payCount = async () => (await db.query('SELECT COUNT(*)::int n FROM payments WHERE order_id=$1', [lo.id])).rows[0].n;
  await backfillLegacyPayments(db, 1000);
  ok(await payCount() === 0, 'Relleno: un pedido de un día con la caja cerrada se omite');
  await db.query('UPDATE cash_closings SET reopened_at = now() WHERE tenant_id=$1', [L.id]);
  await backfillLegacyPayments(db, 1000);
  ok(await payCount() === 1, 'Reabierta la caja de ese día, el relleno lo convierte en un pago');
  await db.query('DELETE FROM tenants WHERE id=$1', [L.id]);

  // ═══ 8) Utilidad: envío nulo y top de productos sin artículos ═══
  const U = await reg('Util');
  await db.query("UPDATE tenants SET plan='pro' WHERE id=$1", [U.id]);
  const u1 = await newOrder(U.H, 100);
  await db.query('UPDATE orders SET shipping = NULL WHERE id=$1', [u1.id]);
  r = await get(U.H, '/api/reports/profit?period=hoy');
  ok(r.status === 200 && r.body.vendido === 100 && r.body.ventasItems === 100, 'Utilidad con envío NULL: calcula igual (100)');
  const u2 = (await post(U.H, '/api/orders', { clientName: 'Sin art', totalPrice: 30, productSummary: 'Solo resumen' })).body;
  r = await get(U.H, '/api/reports?period=hoy');
  ok(r.status === 200 && r.body.topProducts.some(t => /Solo resumen/.test(t[0]) && t[1] === 1 && t[2] === '$30'), 'Top productos: un pedido sin artículos cuenta con su total');
  await db.query('UPDATE orders SET credited_total = total_price WHERE id=$1', [u2.id]);
  r = await get(U.H, '/api/reports?period=hoy');
  ok(!r.body.topProducts.some(t => /Solo resumen/.test(t[0])), 'Devuelto por completo (neto 0): sale del top de productos');
  await db.query('DELETE FROM tenants WHERE id=$1', [U.id]);

  // ═══ 11) DELETE /api/catalog/:id con id que no es UUID → 404 ═══
  r = await send(A.H, 'DELETE', '/api/catalog/no-es-uuid');
  ok(r.status === 404, 'DELETE catálogo con un id que no es UUID → 404');
  r = await send(B.H, 'DELETE', `/api/catalog/${P.id}`);
  ok(r.status === 404, 'DELETE del producto de otro negocio → 404');
  r = await send(A.H, 'DELETE', `/api/catalog/${Q2.id}`);
  ok(r.status === 200, 'DELETE de un producto propio → 200');

  // ═══ Demos: tope de niveles de existencias ═══
  const adm = await adminToken();
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm, 'X-Demo-Key': DEMO_KEY };
  const demo = (await j('/api/admin/demos', { method: 'POST', headers: AH, body: JSON.stringify({ email: 'rev4a' + Date.now() + '@test.local', businessName: 'Demo 4A', days: 2, sendEmail: false }) })).body;
  const dl = (await j('/api/tenant/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: demo.email, password: demo.password }) })).body;
  const DH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + dl.token };
  const dprod = (await get(DH, '/api/catalog')).body.find(p => p.trackStock);
  await db.query(`INSERT INTO stock_levels (tenant_id, product_id, variant_key, qty)
    SELECT $1, $2, 'zz' || g, 1 FROM generate_series(1, 1500) g`, [demo.tenantId, dprod.id]);
  r = await post(DH, '/api/stock/adjust', { productId: dprod.id, delta: 1, note: 'x' });
  ok(r.status === 429 && r.body.error === 'demo_limit', 'Demo: tope de 1500 niveles de existencias');
  await db.query('DELETE FROM tenants WHERE id=$1', [demo.tenantId]);

  for (const t of [A.id, B.id, C.id]) await db.query('DELETE FROM tenants WHERE id=$1', [t]);
  await db.end();
});
