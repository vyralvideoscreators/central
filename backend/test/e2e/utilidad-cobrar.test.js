// Fase 4A: utilidad (vendido, cobrado, devuelto, costo, bruta, gastos, neta, ventas sin costo), por cobrar con antigüedad,
// top productos con devoluciones y margen, y el filtro de plan.
const { ok, j, send, reg, db: dbConnect, run } = require('../helpers/harness');
const post = (H, u, b) => send(H, 'POST', u, b);
const TZ = 'America/Caracas';
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

run(async () => {
  const db = await dbConnect();
  const A = await reg('Utilidad A'), B = await reg('Utilidad B'), C = await reg('Cobrar C'), D = await reg('Basic D');
  await db.query('UPDATE tenants SET timezone=$1, plan=$2 WHERE id = ANY($3)', [TZ, 'pro', [A.id, B.id, C.id]]);

  // ── Plan: basic → 403 en los informes nuevos ──
  for (const u of ['/api/reports/profit?period=mes', '/api/reports/receivables']) {
    const r = await j(u, { headers: D.H });
    ok(r.status === 403 && r.body.error === 'plan_required', 'Plan basic: ' + u + ' → 403 plan_required');
  }
  let r = await j('/api/reports/profit?period=raro', { headers: A.H });
  ok(r.status === 400, 'Periodo inválido → 400');
  r = await j('/api/reports/profit?period=personalizado&from=2026-02-31&to=2026-03-01', { headers: A.H });
  ok(r.status === 400, 'Fecha imposible → 400');

  // ── Utilidad con descuento e impuesto ──
  r = await send(A.H, 'PUT', '/api/tenant/settings', { tax: { enabled: true, rate: 10, label: 'IVA' } });
  ok(r.status === 200, 'Impuesto del 10 % activado');
  const P1 = (await post(A.H, '/api/catalog', { name: 'Prod Costo', price: 30, emoji: '👕', cost: 10 })).body;
  const P2 = (await post(A.H, '/api/catalog', { name: 'Prod Sin', price: 50, emoji: '👖' })).body;
  r = await post(A.H, '/api/orders', { clientName: 'Cli Uno', platform: 'wa', shipping: 5, discount: 11,
    items: [{ productId: P1.id, name: 'Prod Costo', qty: 2, unitPrice: 30 }, { productId: P2.id, name: 'Prod Sin', qty: 1, unitPrice: 50 }] });
  const o1 = r.body;
  // Líneas 110 − descuento 11 = 99; impuesto 9.90; total = 99 + 9.90 + 5 = 113.90
  ok(r.status === 200 && near(o1.totalPrice, 113.9) && near(o1.taxAmount, 9.9), 'Pedido: 110 − 11 + 9.90 de impuesto + 5 de envío = 113.90');
  await post(A.H, `/api/orders/${o1.id}/payments`, { amount: 50, method: 'Efectivo' });
  r = await post(A.H, '/api/orders', { clientName: 'Cli Dos', platform: 'ig', totalPrice: 40 });
  const o2 = r.body;
  ok(r.status === 200 && o2.items.length === 0 && near(o2.totalPrice, 40), 'Pedido antiguo sin artículos por 40');
  await post(A.H, `/api/orders/${o2.id}/payments`, { amount: 20, method: 'Zelle' });
  const q = (await post(A.H, '/api/orders', { clientName: 'Presupuesto', kind: 'quote', items: [{ name: 'X', qty: 1, unitPrice: 999 }] })).body;
  const oc = (await post(A.H, '/api/orders', { clientName: 'Anulado', platform: 'wa', items: [{ name: 'Y', qty: 1, unitPrice: 777 }] })).body;
  await post(A.H, `/api/orders/${oc.id}/cancel`, { reason: 'x' });
  ok(q.kind === 'quote' && (await j('/api/orders', { headers: A.H })).body.find(o => o.id === oc.id).cancelled, 'Un presupuesto y un pedido anulado (no cuentan)');

  r = await j('/api/reports/profit?period=hoy', { headers: A.H });
  let p = r.body;
  ok(r.status === 200 && p.pedidos === 2, 'Utilidad: 2 pedidos (sin presupuestos ni anulados)');
  ok(near(p.vendido, 113.9 + 40) && near(p.cobrado, 70) && p.devuelto === 0, 'Vendido 153.90, cobrado 70, devuelto 0');
  ok(near(p.ventasItems, 99 + 40) && near(p.costo, 20) && near(p.utilidadBruta, 119 - 0), 'Ventas de artículos 139 (sin envío ni impuesto, con descuento prorrateado + pedido viejo 40), costo 20, utilidad bruta 119');
  ok(near(p.ventasSinCosto, 45 + 40) && near(p.ventasConCosto, 54), 'Ventas sin costo = 45 (Prod Sin con descuento) + 40 (pedido sin artículos); con costo = 54');
  ok(near(p.margenBruto, 63) && p.gastos === 0 && near(p.utilidadNeta, 119), 'Margen sobre lo que tiene costo (63 %), sin gastos: neta = bruta');
  ok(p.baseCurrency === 'USD' && p.gastosAplican === true, 'Moneda base y gastos aplican');

  // Devolución por artículos de 1 unidad de Prod Costo: baja ventas, costo, vendido y suma «devuelto»
  const oFull = (await j('/api/orders', { headers: A.H })).body.find(o => o.id === o1.id);
  const itemId = oFull.items.find(i => i.name === 'Prod Costo').id;
  r = await post(A.H, `/api/orders/${o1.id}/returns`, { reason: 'Talla', items: [{ orderItemId: itemId, qty: 1 }], resolution: 'refund' });
  ok(r.status === 200, 'Devolución de 1 unidad de Prod Costo');
  const noteAmount = r.body.creditNote.amountBase;
  r = await post(A.H, `/api/orders/${o2.id}/returns`, { reason: 'Importe', amount: 10, resolution: 'refund', refundMethod: 'Zelle' });
  ok(r.status === 200, 'Devolución por importe de 10 en el pedido sin artículos');
  await send(A.H, 'PATCH', `/api/catalog/${P1.id}`, { name: 'Prod Costo', price: 30, cost: 99 });
  const e1 = (await post(A.H, '/api/expenses', { amount: 12, category: 'Envíos', method: 'Efectivo' })).body.expense;
  const e2 = (await post(A.H, '/api/expenses', { amount: 5, category: 'Otros', method: 'Efectivo' })).body.expense;
  await post(A.H, `/api/expenses/${e2.id}/void`, { reason: 'Error' });
  r = await j('/api/reports/profit?period=hoy', { headers: A.H });
  p = r.body;
  ok(near(p.devuelto, noteAmount + 10) && p.devueltoCount === 2, 'Devuelto = notas de crédito del periodo (' + p.devuelto + ')');
  ok(near(p.vendido, 113.9 - noteAmount + 30), 'Vendido neto = total efectivo de los pedidos (' + p.vendido + ')');
  ok(near(p.ventasItems, 72 + 30) && near(p.costo, 10) && near(p.utilidadBruta, 92), 'Tras devolver: ventas 72 (27 + 45) + 30, costo 10 (solo lo no devuelto), bruta 92');
  ok(near(p.ventasSinCosto, 45 + 30) && near(p.ventasConCosto, 27), 'Ventas sin costo 75, con costo 27');
  ok(p.costo === 10, 'Cambiar el costo del producto después (99) NO cambia la utilidad: la foto sigue en 10');
  ok(p.gastos === 12 && p.gastosCount === 1 && near(p.utilidadNeta, 80), 'Gastos 12 (el anulado no cuenta); utilidad neta = 92 − 12 = 80');
  r = await j('/api/reports/profit?period=hoy&canal=wa', { headers: A.H });
  ok(near(r.body.ventasItems, 72) && near(r.body.costo, 10) && r.body.gastos === null && r.body.utilidadNeta === null && r.body.gastosAplican === false, 'Canal WhatsApp: solo su pedido; los gastos (sin canal) no se calculan');
  r = await j('/api/reports/profit?period=hoy&canal=ig', { headers: A.H });
  ok(near(r.body.ventasItems, 30) && near(r.body.vendido, 30), 'Canal Instagram: solo el pedido sin artículos (30)');
  r = await j('/api/reports/profit?period=personalizado&from=2020-01-01&to=2020-01-31', { headers: A.H });
  ok(r.status === 200 && r.body.pedidos === 0 && r.body.vendido === 0 && r.body.gastos === 0, 'Un periodo sin movimientos da ceros');
  r = await j('/api/reports/profit?period=hoy', { headers: B.H });
  ok(r.status === 200 && r.body.pedidos === 0 && r.body.vendido === 0 && r.body.gastos === 0, 'Aislamiento: otro negocio no ve nada de A');

  // ── Top productos: descuenta devoluciones y trae margen ──
  r = await j('/api/reports?period=hoy', { headers: A.H });
  const top = Object.fromEntries(r.body.topProducts.map(t => [t[0], t]));
  ok(top['📦 Prod Costo'] && top['📦 Prod Costo'][1] === 1 && top['📦 Prod Costo'][2] === '$30', 'Top productos: Prod Costo = 1 unidad (se devolvió 1 de 2), ventas $30');
  ok(top['📦 Prod Costo'][3] === 67 && top['📦 Prod Sin'][3] === null, 'Margen 67 % con costo (30 − 10); sin costo → null');
  ok(r.body.topProducts.every(t => t.length === 4), 'Cada fila trae [nombre, unidades, ventas, margen]');

  // ── Por cobrar con antigüedad ──
  const mk = async (name, total, extra = {}) => (await post(C.H, '/api/orders', { clientName: name, items: [{ name: 'Art', qty: 1, unitPrice: total }], ...extra })).body;
  const age = async (o, days) => db.query(`UPDATE orders SET created_at = NOW() - ($2 || ' days')::interval WHERE id = $1`, [o.id, String(days)]);
  const ficha = (await post(C.H, '/api/clients', { name: 'Carla Ficha' })).body;
  const r1 = await mk('Ana', 100); await age(r1, 3);
  const r2 = await mk('Ana', 40); await age(r2, 90);
  const r3 = await mk('Beto', 50); await age(r3, 10);
  await post(C.H, `/api/orders/${r3.id}/payments`, { amount: 20, method: 'Efectivo' });
  const r4 = await mk('Carla', 70, { clientId: ficha.id }); await age(r4, 45);
  const r5 = await mk('Pagado', 60); await post(C.H, `/api/orders/${r5.id}/payments`, { amount: 60, method: 'Efectivo' }); await age(r5, 100);
  const r6 = await mk('Anulado', 80); await post(C.H, `/api/orders/${r6.id}/cancel`, { reason: 'x' }); await age(r6, 100);
  await post(C.H, '/api/orders', { clientName: 'Presu', kind: 'quote', items: [{ name: 'Art', qty: 1, unitPrice: 300 }] });
  const r7 = await mk('Devuelto', 30); await age(r7, 5);
  await post(C.H, `/api/orders/${r7.id}/returns`, { reason: 'x', amount: 30, resolution: 'refund' });
  r = await j('/api/reports/receivables', { headers: C.H });
  const bk = Object.fromEntries(r.body.buckets.map(b => [b.key, b]));
  ok(r.status === 200 && bk['0-7'].total === 100 && bk['0-7'].count === 1, 'Tramo 0–7: 100 (1 pedido; el devuelto del todo ya no debe nada)');
  ok(bk['8-30'].total === 30 && bk['8-30'].count === 1, 'Tramo 8–30: 30 (50 menos un abono de 20)');
  ok(bk['31-60'].total === 70 && bk['60+'].total === 40 && bk['60+'].count === 1, 'Tramos 31–60: 70 y más de 60: 40 (el pagado, el anulado y el presupuesto no cuentan)');
  ok(r.body.total === 240 && r.body.count === 4, 'Total por cobrar 240 en 4 pedidos');
  const names = r.body.debtors.map(d => d.name);
  ok(names.join() === 'Ana,Carla,Beto', 'Clientes deudores por total descendente: ' + names.join());
  const ana = r.body.debtors[0];
  ok(ana.total === 140 && ana.orders === 2 && ana.oldestDays >= 90 && ana.bucket === '60+' && /^#\d{4}$/.test(ana.oldestOrder), 'Ana (mismo nombre, dos pedidos): 140, el más antiguo con 90 días, tramo >60');
  ok(r.body.debtors[1].clientId === ficha.id && r.body.debtors[1].total === 70, 'Con ficha: agrupa por clientId');
  r = await j('/api/reports/receivables', { headers: A.H });
  ok(r.status === 200 && !r.body.debtors.some(d => d.name === 'Ana'), 'Aislamiento: otro negocio no ve a los deudores de C');

  // Límite de la lista
  await Promise.all(Array.from({ length: 52 }, (_, i) => mk('Deudor ' + String(i).padStart(2, '0'), 1000 + i)));
  r = await j('/api/reports/receivables', { headers: C.H });
  ok(r.body.debtors.length === 50 && r.body.truncated === true && r.body.count === 56, 'La lista de deudores se limita a 50 (truncated) pero los tramos cuentan todos (56)');

  await db.end();
});
