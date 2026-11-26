// Fase 4A en las cuentas demo: rutas permitidas, topes, datos de ejemplo coherentes, reinicio y «Hacer real»
const { ok, j, send, run, db: dbConnect, metaCalls, clearMeta, DEMO_KEY, adminToken } = require('../helpers/harness');
const post = (H, u, b) => send(H, 'POST', u, b);

run(async () => {
  const db = await dbConnect();
  const adm = await adminToken();
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm, 'X-Demo-Key': DEMO_KEY };
  const email = 'demo4a' + Date.now() + '@test.local';
  const demo = (await j('/api/admin/demos', { method: 'POST', headers: AH, body: JSON.stringify({ email, businessName: 'Demo Fase 4A', days: 3, sendEmail: false }) })).body;
  const login = (await j('/api/tenant/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: demo.password }) })).body;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  const T = demo.tenantId;
  clearMeta();
  const q = async (sql, p = [T]) => (await db.query(sql, p)).rows;
  const one = async (sql, p = [T]) => (await q(sql, p))[0];

  // ── Datos de ejemplo ──
  ok((await one('SELECT COUNT(*)::int n FROM expenses WHERE tenant_id=$1')).n === 8 && (await one('SELECT COUNT(*)::int n FROM expenses WHERE tenant_id=$1 AND voided_at IS NOT NULL')).n === 1, 'Demo: 8 gastos de ejemplo (uno anulado)');
  const cc = await q('SELECT * FROM cash_closings WHERE tenant_id=$1');
  ok(cc.length === 1 && cc[0].reopened_at === null, 'Demo: un día cerrado');
  const dif = Object.values(cc[0].difference).reduce((a, b) => a + Number(b), 0);
  ok(Math.abs(dif) > 0 && Math.abs(dif) < 5, 'Demo: el cierre tiene una pequeña diferencia (' + dif.toFixed(2) + ')');
  const costs = await q('SELECT name, cost, track_stock FROM catalog_products WHERE tenant_id=$1 ORDER BY name');
  ok(costs.filter(c => c.cost !== null).length === 4 && costs.filter(c => c.cost === null).length === 1 && costs.filter(c => c.track_stock).length === 3, 'Demo: costos en 4 productos (uno sin costo) y control de existencias en 3');
  const lv = await q('SELECT l.qty, l.variant_key, p.name FROM stock_levels l JOIN catalog_products p ON p.id = l.product_id WHERE l.tenant_id=$1');
  ok(lv.some(l => l.qty < 0), 'Demo: alguna variante está en negativo (' + lv.filter(l => l.qty < 0).map(l => l.name + ' ' + l.variant_key + '=' + l.qty).join(', ') + ')');
  ok(lv.filter(l => l.name === 'Tenis Urbano Nube').length === 12, 'Demo: existencias por talla × color (12 variantes de los tenis)');
  const bad = await q(`SELECT l.product_id, l.variant_key FROM stock_levels l WHERE l.tenant_id=$1 AND l.qty <> COALESCE((SELECT SUM(m.delta) FROM stock_movements m WHERE m.tenant_id=l.tenant_id AND m.product_id=l.product_id AND m.variant_key=l.variant_key), 0)`);
  ok(bad.length === 0, 'Demo: cada nivel coincide con la suma de sus movimientos');
  ok((await one(`SELECT COUNT(*)::int n FROM order_items WHERE tenant_id=$1 AND variant_key IS NOT NULL AND unit_cost IS NOT NULL`)).n > 5, 'Demo: las líneas de pedidos traen variante y costo');

  // ── Rutas permitidas ──
  let r = await j('/api/expenses?period=month', { headers: H });
  ok(r.status === 200 && r.body.expenses.length > 0, 'Demo: GET /api/expenses');
  r = await post(H, '/api/expenses', { amount: 7, category: 'Otros', method: 'Efectivo', note: 'prueba demo' });
  ok(r.status === 200, 'Demo: registrar un gasto');
  const today = (await j('/api/cash/' + new Date().toISOString().slice(0, 10), { headers: H })).body.today;
  r = await j('/api/cash/' + today, { headers: H });
  ok(r.status === 200 && r.body.status === 'open', 'Demo: GET /api/cash/:day');
  const counted = r.body.rows.map(m => ({ method: m.method, currency: m.currency, amount: Math.max(0, m.expected) }));
  r = await post(H, `/api/cash/${today}/close`, { counted });
  ok(r.status === 200 && r.body.status === 'closed', 'Demo: cerrar la caja de hoy');
  r = await post(H, `/api/cash/${today}/reopen`, { reason: 'prueba' });
  ok(r.status === 200 && r.body.status === 'open', 'Demo: reabrirla');
  r = await j('/api/cash?period=7d', { headers: H });
  ok(r.status === 200 && r.body.closings.length >= 2, 'Demo: GET /api/cash (lista)');
  const prods = (await j('/api/catalog', { headers: H })).body;
  const tenis = prods.find(p => p.name === 'Tenis Urbano Nube');
  ok(tenis.trackStock === true && tenis.cost === 27, 'Demo: el catálogo trae costo y control de existencias');
  r = await j('/api/stock', { headers: H });
  ok(r.status === 200 && r.body.levels.length >= 30, 'Demo: GET /api/stock');
  r = await post(H, '/api/stock/adjust', { productId: tenis.id, size: '38', color: 'Verde menta', delta: 4, note: 'Llegó mercancía' });
  ok(r.status === 200 && r.body.movement.reason === 'adjust_in', 'Demo: ajustar existencias');
  r = await j(`/api/stock/movements?productId=${tenis.id}`, { headers: H });
  ok(r.status === 200 && r.body.movements.length > 0, 'Demo: movimientos');
  r = await j('/api/reports/profit?period=año', { headers: H });
  ok(r.status === 200 && r.body.pedidos > 0 && r.body.ventasSinCosto > 0 && r.body.costo > 0 && r.body.gastos > 0, 'Demo: utilidad con costo, ventas sin costo y gastos');
  r = await j('/api/reports/receivables', { headers: H });
  ok(r.status === 200 && r.body.count > 0 && r.body.debtors.length > 0, 'Demo: por cobrar con antigüedad');
  ok(metaCalls().length === 0, 'Demo: ninguna llamada a Meta ni a servicios externos');

  // ── Topes ──
  await db.query(`INSERT INTO expenses (tenant_id, spent_on, amount, currency, amount_base, category, method)
    SELECT $1, CURRENT_DATE, 1, 'USD', 1, 'Otros', 'Efectivo' FROM generate_series(1, 300)`, [T]);
  r = await post(H, '/api/expenses', { amount: 1, category: 'Otros', method: 'Efectivo' });
  ok(r.status === 429 && r.body.error === 'demo_limit', 'Demo: tope de 300 gastos');
  await db.query(`INSERT INTO cash_closings (tenant_id, day, expected, counted, difference, reopened_at)
    SELECT $1, DATE '2020-01-01' + g, '{}', '{}', '{}', now() FROM generate_series(1, 60) g`, [T]);
  r = await post(H, `/api/cash/${today}/close`, { counted });
  ok(r.status === 429 && r.body.error === 'demo_limit', 'Demo: tope de 60 cierres de caja');
  const o0 = (await j('/api/orders', { headers: H })).body.find(o => o.kind === 'order' && !o.cancelled);
  await db.query(`INSERT INTO stock_movements (tenant_id, product_id, variant_key, delta, qty_after, reason)
    SELECT $1, $2, 'x' || g, 1, 1, 'adjust_in' FROM generate_series(1, 3000) g`, [T, tenis.id]);
  r = await post(H, '/api/stock/adjust', { productId: tenis.id, size: '38', color: 'Verde menta', delta: 1, note: 'otro' });
  ok(r.status === 429 && r.body.error === 'demo_limit', 'Demo: tope de 3000 movimientos de existencias');
  r = await post(H, '/api/orders', { clientName: 'Tope', items: [{ name: 'A', qty: 1, unitPrice: 1 }] });
  ok(r.status === 429 && r.body.error === 'demo_limit', 'Demo: crear pedidos también respeta el tope de movimientos');
  ok(o0 !== undefined, 'Demo: (había pedidos)');

  // ── Reiniciar datos vuelve a sembrar (sin acumular lo nuevo) ──
  r = await j(`/api/admin/demos/${T}/reset-data`, { method: 'POST', headers: AH });
  ok(r.status === 200 || r.body.success, 'Demo: reiniciar datos');
  ok((await one('SELECT COUNT(*)::int n FROM expenses WHERE tenant_id=$1')).n === 8 && (await one('SELECT COUNT(*)::int n FROM cash_closings WHERE tenant_id=$1')).n === 1
    && (await one('SELECT COUNT(*)::int n FROM stock_movements WHERE tenant_id=$1')).n < 100, 'Demo: tras reiniciar quedan solo los datos de ejemplo');

  // ── Hacer real: se borra todo lo nuevo ──
  await j(`/api/admin/demos/${T}/convert`, { method: 'POST', headers: AH });
  const left = await one(`SELECT (SELECT COUNT(*) FROM expenses WHERE tenant_id=$1)::int e, (SELECT COUNT(*) FROM cash_closings WHERE tenant_id=$1)::int c,
    (SELECT COUNT(*) FROM stock_levels WHERE tenant_id=$1)::int l, (SELECT COUNT(*) FROM stock_movements WHERE tenant_id=$1)::int m,
    (SELECT COUNT(*) FROM catalog_products WHERE tenant_id=$1)::int p`);
  ok(left.e === 0 && left.c === 0 && left.l === 0 && left.m === 0 && left.p === 0, 'Hacer real: gastos, cierres, existencias y movimientos quedan en cero');

  await db.query('DELETE FROM tenants WHERE id=$1', [T]);
  await db.end();
});
