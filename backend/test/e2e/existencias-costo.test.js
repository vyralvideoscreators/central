// Fase 4A: costo y existencias por variante (venta, presupuesto, anulación, devolución, edición, ajustes, aislamiento)
const path = require('path');
const { spawn } = require('child_process');
const { ok, j, send, reg, db: dbConnect, run } = require('../helpers/harness');
const post = (H, u, b) => send(H, 'POST', u, b);
const ROOT = path.join(__dirname, '..', '..');
const PORT2 = Number(process.env.PORT || 3990) + 8;

async function startSecondServer() {
  const env = { ...process.env, PORT: String(PORT2), APP_URL: `http://localhost:${PORT2}` };
  const mock = path.join(ROOT, 'test', 'helpers', 'mock-meta.js');
  const p = spawn(process.execPath, ['--require', mock, 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 200));
    try { const h = await fetch(`http://127.0.0.1:${PORT2}/health`).then(r => r.json()); if (h && h.db) return { p, log: () => log }; } catch {}
    if (p.exitCode !== null) break;
  }
  p.kill();
  throw new Error('El segundo servidor no arrancó:\n' + log);
}

run(async () => {
  const db = await dbConnect();
  const A = await reg('Existencias A'), B = await reg('Existencias B');
  await db.query('UPDATE tenants SET plan=$1 WHERE id = ANY($2)', ['pro', [A.id, B.id]]);
  const level = async (pid, key) => { const r = await db.query('SELECT qty FROM stock_levels WHERE product_id=$1 AND variant_key=$2', [pid, key]); return r.rows[0] ? r.rows[0].qty : null; };
  const moves = async (oid) => (await db.query('SELECT reason, delta, variant_key FROM stock_movements WHERE order_id=$1 ORDER BY created_at, id', [oid])).rows;
  const dbCost = async (oid) => (await db.query('SELECT unit_cost, variant_key, product_id FROM order_items WHERE order_id=$1 ORDER BY ctid', [oid])).rows;
  const colors = [{ name: 'Rojo', hex: '#f00' }, { name: 'Azul', hex: '#00f' }];
  const prodBody = (extra = {}) => ({ name: 'Camisa', price: 20, emoji: '👕', sizes: ['S', 'M'], colors, ...extra });
  const sale = (H, pid, size, color, qty, extra = {}) => post(H, '/api/orders', { clientName: 'Cli', items: [{ productId: pid, name: 'Camisa', size, color, qty, unitPrice: 20 }], ...extra });

  // ── Catálogo: costo y control de existencias ──
  let r = await post(A.H, '/api/catalog', prodBody());
  ok(r.status === 200 && r.body.cost === null && r.body.trackStock === false, 'Producto nuevo: sin costo y sin control de existencias');
  const P = r.body;
  r = await send(A.H, 'PATCH', `/api/catalog/${P.id}`, prodBody({ cost: -1 }));
  ok(r.status === 400 && /Costo/.test(r.body.error), 'Costo negativo → 400');
  r = await send(A.H, 'PATCH', `/api/catalog/${P.id}`, prodBody({ cost: 'abc' }));
  ok(r.status === 400, 'Costo no numérico → 400');
  r = await send(A.H, 'PATCH', `/api/catalog/${P.id}`, prodBody({ trackStock: 'si' }));
  ok(r.status === 400, 'trackStock que no es booleano → 400');
  r = await send(A.H, 'PATCH', '/api/catalog/no-es-uuid', prodBody());
  ok(r.status === 404, 'Id que no es UUID → 404');
  r = await send(A.H, 'PATCH', `/api/catalog/${P.id}`, prodBody({ cost: 8, trackStock: true }));
  ok(r.status === 200 && r.body.cost === 8 && r.body.trackStock === true, 'PATCH guarda costo 8 y control de existencias');
  r = await send(A.H, 'PATCH', `/api/catalog/${P.id}`, prodBody({ price: 22 }));
  ok(r.status === 200 && r.body.cost === 8 && r.body.trackStock === true && r.body.price === '22.00', 'Un PATCH sin costo ni trackStock los conserva');
  r = await send(A.H, 'PATCH', `/api/catalog/${P.id}`, prodBody({ price: 20, cost: 8 }));
  const Q = (await post(A.H, '/api/catalog', prodBody({ name: 'Gorra sin control', sizes: [], colors: [], cost: 3 }))).body;
  ok(Q.cost === 3 && Q.trackStock === false, 'Se puede crear con costo (POST)');
  r = await j('/api/catalog', { headers: A.H });
  ok(r.body.find(x => x.id === P.id).cost === 8, 'GET /api/catalog trae el costo');

  // ── Ajustes manuales ──
  r = await post(A.H, '/api/stock/adjust', { productId: Q.id, count: 5, note: 'x' });
  ok(r.status === 400 && /control de existencias/.test(r.body.error), 'Ajustar un producto sin control → 400');
  const adj = (b) => post(A.H, '/api/stock/adjust', { productId: P.id, ...b });
  r = await adj({ size: 'S', color: 'Rojo', count: 10 });
  ok(r.status === 400 && /Motivo/.test(r.body.error), 'Ajuste sin motivo → 400');
  r = await adj({ size: 'S', color: 'Rojo', count: 10, delta: 2, note: 'x' });
  ok(r.status === 400, 'delta y count a la vez → 400');
  r = await adj({ size: 'S', color: 'Rojo', delta: 0, note: 'x' });
  ok(r.status === 400, 'delta 0 → 400');
  r = await adj({ size: 'S', color: 'Rojo', delta: 1.5, note: 'x' });
  ok(r.status === 400, 'delta decimal → 400');
  r = await adj({ size: 'S', color: 'Rojo', count: -1, note: 'x' });
  ok(r.status === 400, 'Conteo negativo → 400');
  r = await adj({ size: 'S', color: 'Rojo', count: 10, note: 'Inventario inicial' });
  ok(r.status === 200 && r.body.level === 10 && r.body.movement.reason === 'count' && r.body.movement.delta === 10 && r.body.movement.qtyAfter === 10, 'Conteo inicial de S Rojo = 10');
  r = await adj({ variantKey: 'S|Rojo', delta: 5, note: 'Compra' });
  ok(r.status === 200 && r.body.level === 15 && r.body.movement.reason === 'adjust_in', 'Entrada de 5 (con variantKey en otra mayúscula = misma variante)');
  r = await adj({ size: ' s ', color: 'ROJO', delta: -3, note: 'Merma' });
  ok(r.status === 200 && r.body.level === 12 && r.body.movement.reason === 'adjust_out' && r.body.variantKey === 's|rojo', 'Salida de 3: la clave se normaliza (12)');
  r = await adj({ size: 'S', color: 'Rojo', count: 12, note: 'Recuento' });
  ok(r.status === 200 && r.body.unchanged === true && r.body.movement === null, 'Un conteo igual al nivel no crea movimiento');
  r = await adj({ size: 'S', color: 'Rojo', delta: 1, reason: 'adjust_out', note: 'x' });
  ok(r.status === 400, 'Motivo que no coincide con el signo → 400');
  r = await j(`/api/stock?productId=${P.id}`, { headers: A.H });
  ok(r.status === 200 && r.body.variants.length === 4 && r.body.variants.some(v => v.key === 's|rojo' && v.size === 'S' && v.color === 'Rojo') && r.body.levels.find(l => l.variantKey === 's|rojo').qty === 12 && r.body.trackStock === true && r.body.cost === 8,
    'GET /api/stock?productId trae las 4 variantes talla × color y el nivel');
  r = await j('/api/stock', { headers: A.H });
  ok(r.status === 200 && r.body.levels.length === 1 && r.body.levels[0].qty === 12, 'GET /api/stock (todos) trae los niveles del negocio');

  // ── Venta: descuenta por variante, foto del costo ──
  r = await sale(A.H, P.id, 'S', 'Rojo', 3);
  ok(r.status === 200 && r.body.items[0].productId === P.id && r.body.items[0].variantKey === 's|rojo', 'Pedido con producto y variante: la línea guarda la clave derivada');
  const o1 = r.body;
  ok(await level(P.id, 's|rojo') === 9, 'La venta de 3 descuenta: 12 → 9');
  let cs = await dbCost(o1.id);
  ok(Number(cs[0].unit_cost) === 8 && cs[0].variant_key === 's|rojo', 'unit_cost = 8 (foto del costo al vender)');
  ok(JSON.stringify(await moves(o1.id)) === JSON.stringify([{ reason: 'sale', delta: -3, variant_key: 's|rojo' }]), 'Un movimiento «sale» de −3 ligado al pedido');
  r = await sale(A.H, P.id, 'M', 'Azul', 2);
  ok(r.status === 200 && await level(P.id, 'm|azul') === -2, 'Sin existencias se permite vender: la variante queda en −2');
  const oNeg = r.body;
  r = await send(A.H, 'PATCH', `/api/catalog/${P.id}`, prodBody({ cost: 15 }));
  cs = await dbCost(o1.id);
  ok(r.body.cost === 15 && Number(cs[0].unit_cost) === 8, 'Cambiar el costo después NO cambia la foto del pedido ya vendido');
  r = await sale(A.H, P.id, 'S', 'Azul', 1);
  ok(Number((await dbCost(r.body.id))[0].unit_cost) === 15, 'Un pedido nuevo toma el costo vigente (15)');
  const oAzul = r.body;

  // ── Presupuesto: no descuenta; convertir sí ──
  r = await post(A.H, '/api/orders', { clientName: 'Cli', kind: 'quote', items: [{ productId: P.id, name: 'Camisa', size: 'S', color: 'Rojo', qty: 4, unitPrice: 20 }] });
  const q1 = r.body;
  ok(r.status === 200 && await level(P.id, 's|rojo') === 9 && (await moves(q1.id)).length === 0, 'Un presupuesto no descuenta');
  cs = await dbCost(q1.id);
  ok(cs[0].unit_cost === null, '… ni toma foto del costo todavía');
  r = await post(A.H, `/api/orders/${q1.id}/convert`, {});
  ok(r.status === 200 && await level(P.id, 's|rojo') === 5, 'Convertir descuenta en ese momento: 9 → 5');
  cs = await dbCost(q1.id);
  ok(Number(cs[0].unit_cost) === 15, '… y toma la foto del costo vigente al convertir (15)');
  r = await post(A.H, '/api/orders', { clientName: 'Cli', kind: 'quote', items: [{ productId: P.id, name: 'Camisa', size: 'S', color: 'Rojo', qty: 9, unitPrice: 20 }] });
  const q2 = r.body;
  r = await post(A.H, `/api/orders/${q2.id}/cancel`, { reason: 'No lo quiso' });
  ok(r.status === 200 && await level(P.id, 's|rojo') === 5 && (await moves(q2.id)).length === 0, 'Anular un presupuesto no mueve existencias');

  // ── Anular un pedido devuelve lo que queda ──
  r = await post(A.H, `/api/orders/${o1.id}/cancel`, { reason: 'Cliente canceló' });
  ok(r.status === 200 && await level(P.id, 's|rojo') === 8, 'Anular el pedido de 3: 5 → 8');
  ok((await moves(o1.id)).map(m => m.reason).join() === 'sale,cancel', 'Movimientos del pedido: sale, cancel');

  // ── Devolución por artículos / por importe ──
  r = await sale(A.H, P.id, 'S', 'Rojo', 2);
  const o2 = r.body;
  ok(await level(P.id, 's|rojo') === 6, 'Venta de 2: 8 → 6');
  r = await post(A.H, `/api/orders/${o2.id}/returns`, { reason: 'Importe', amount: 5, resolution: 'credit' });
  ok(r.status === 200 && await level(P.id, 's|rojo') === 6, 'Una devolución por importe no mueve existencias');
  const itemId = (await j('/api/orders', { headers: A.H })).body.find(o => o.id === o2.id).items[0].id;
  r = await post(A.H, `/api/orders/${o2.id}/returns`, { reason: 'Talla', items: [{ orderItemId: itemId, qty: 1 }], resolution: 'credit' });
  ok(r.status === 200 && await level(P.id, 's|rojo') === 7, 'Devolver 1 unidad por artículos: 6 → 7');
  ok((await moves(o2.id)).map(m => m.reason).join() === 'sale,return', 'Movimiento «return»');
  r = await post(A.H, `/api/orders/${o2.id}/cancel`, { reason: 'Se anula el resto', resolution: 'credit' });
  ok(r.status === 200 && await level(P.id, 's|rojo') === 8, 'Anular después: solo vuelve la unidad que quedaba (7 → 8, no 9)');

  // ── Editar líneas aplica la diferencia ──
  r = await sale(A.H, P.id, 'S', 'Rojo', 3);
  const o3 = r.body;
  ok(await level(P.id, 's|rojo') === 5, 'Venta de 3: 8 → 5');
  r = await send(A.H, 'PATCH', `/api/orders/${o3.id}`, { items: [{ productId: P.id, name: 'Camisa', size: 'S', color: 'Rojo', qty: 1, unitPrice: 20 }] });
  ok(r.status === 200 && await level(P.id, 's|rojo') === 7, 'Editar 3 → 1 devuelve 2 (5 → 7)');
  cs = await dbCost(o3.id);
  ok(Number(cs[0].unit_cost) === 15, 'La línea editada conserva su foto del costo');
  await send(A.H, 'PATCH', `/api/catalog/${P.id}`, prodBody({ cost: 30 }));
  r = await send(A.H, 'PATCH', `/api/orders/${o3.id}`, { items: [r.body.items[0], { productId: P.id, name: 'Camisa', size: 'M', color: 'Rojo', qty: 4, unitPrice: 20 }].map(i => ({ ...i })) });
  ok(r.status === 200 && await level(P.id, 's|rojo') === 7 && await level(P.id, 'm|rojo') === -4, 'Añadir una línea de otra variante descuenta solo esa (M Rojo −4)');
  cs = await dbCost(o3.id);
  ok(Number(cs[0].unit_cost) === 15 && Number(cs[1].unit_cost) === 30, 'La línea vieja conserva 15 y la nueva toma 30');
  r = await send(A.H, 'PATCH', `/api/orders/${o3.id}`, { items: [{ name: 'Libre', qty: 1, unitPrice: 5 }] });
  ok(r.status === 200 && await level(P.id, 's|rojo') === 8 && await level(P.id, 'm|rojo') === 0, 'Quitar las líneas con producto devuelve todo (8 y 0)');
  r = await send(A.H, 'PATCH', `/api/orders/${o3.id}`, { notes: 'solo una nota' });
  ok(r.status === 200 && await level(P.id, 's|rojo') === 8, 'Editar otros campos no mueve existencias');

  // ── Un producto sin control no se mueve; uno ajeno no se enlaza ──
  r = await post(A.H, '/api/orders', { clientName: 'Cli', items: [{ productId: Q.id, name: 'Gorra', qty: 2, unitPrice: 10 }] });
  ok(r.status === 200 && (await db.query('SELECT COUNT(*)::int n FROM stock_movements WHERE product_id=$1', [Q.id])).rows[0].n === 0 && Number((await dbCost(r.body.id))[0].unit_cost) === 3, 'Producto sin control de existencias: sin movimientos, pero con foto del costo');
  const PB = (await post(B.H, '/api/catalog', prodBody({ cost: 99, trackStock: true }))).body;
  await post(B.H, '/api/stock/adjust', { productId: PB.id, size: 'S', color: 'Rojo', count: 7, note: 'inicial B' });
  r = await sale(A.H, PB.id, 'S', 'Rojo', 5);
  cs = await dbCost(r.body.id);
  ok(r.status === 200 && r.body.items[0].productId === null && cs[0].unit_cost === null && cs[0].product_id === null, 'Un product_id de otro negocio no se enlaza ni toma su costo');
  ok(await level(PB.id, 's|rojo') === 7, '… ni descuenta las existencias del otro negocio');

  // ── Aislamiento ──
  r = await post(B.H, '/api/stock/adjust', { productId: P.id, count: 99, note: 'intruso' });
  ok(r.status === 400, 'Otro negocio no puede ajustar existencias de un producto ajeno');
  ok(await level(P.id, '') === null, '… y no se creó ningún nivel');
  r = await j(`/api/stock?productId=${P.id}`, { headers: B.H });
  ok(r.status === 404, 'Otro negocio no ve las existencias de un producto ajeno (404)');
  r = await j(`/api/stock/movements?productId=${P.id}`, { headers: B.H });
  ok(r.status === 200 && r.body.movements.length === 0, 'Ni sus movimientos');
  r = await j('/api/stock', { headers: B.H });
  ok(r.body.levels.length === 1 && r.body.levels[0].productId === PB.id, 'El listado general solo trae lo propio');
  r = await send(B.H, 'PATCH', `/api/catalog/${P.id}`, prodBody({ cost: 1 }));
  ok(r.status === 404, 'Otro negocio no puede cambiar el costo de un producto ajeno');
  r = await j('/api/stock?productId=xyz', { headers: A.H });
  ok(r.status === 404, 'productId que no es UUID → 404');

  // ── Historial ──
  r = await j(`/api/stock/movements?productId=${P.id}&variantKey=${encodeURIComponent('S|Rojo')}&limit=5`, { headers: A.H });
  ok(r.status === 200 && r.body.movements.length === 5 && r.body.truncated === true && r.body.movements[0].qtyAfter !== undefined, 'Historial: el más reciente primero, limitado');
  r = await j(`/api/stock/movements?productId=${P.id}&limit=500`, { headers: A.H });
  const withOrder = r.body.movements.find(m => m.orderId === o1.id);
  ok(r.status === 200 && withOrder && /^#\d{4}$/.test(withOrder.orderNumber) && r.body.movements.some(m => m.reason === 'adjust_in' && m.orderId === null && m.note === 'Compra'), 'Historial con número de pedido y motivo de los ajustes');

  // ── Todo o nada y concurrencia ──
  const before = await level(P.id, 's|rojo');
  r = await sale(A.H, P.id, 'S', 'Rojo', 2, { initialPayment: { amount: 9999, method: 'Efectivo' } });
  ok(r.status === 400 && await level(P.id, 's|rojo') === before, 'Un pedido que falla (pago inicial inválido) no deja existencias descontadas');
  const rs = await Promise.all(Array.from({ length: 6 }, () => sale(A.H, P.id, 'S', 'Rojo', 1)));
  ok(rs.every(x => x.status === 200) && await level(P.id, 's|rojo') === before - 6, 'Seis ventas simultáneas descuentan exactamente 6');
  const sum = Number((await db.query(`SELECT SUM(delta) s FROM stock_movements WHERE product_id=$1 AND variant_key='s|rojo'`, [P.id])).rows[0].s);
  ok(sum === await level(P.id, 's|rojo'), 'El nivel coincide con la suma de sus movimientos');

  // ── Reinicio: otro proceso ejecuta initDB sobre la misma base sin romper nada ──
  const s2 = await startSecondServer();
  s2.p.kill();
  await new Promise(r => setTimeout(r, 300));
  ok(await level(P.id, 's|rojo') === before - 6, 'Tras el reinicio las existencias siguen intactas');
  r = await sale(A.H, P.id, 'S', 'Rojo', 1);
  ok(r.status === 200 && await level(P.id, 's|rojo') === before - 7, '… y se sigue vendiendo con normalidad');

  await db.end();
});
