// Cierre de caja POR MÉTODO Y MONEDA: el esperado se agrupa por (método, moneda) con el importe original
const { ok, j, send, reg, db: dbConnect, run } = require('../helpers/harness');
const post = (H, u, b) => send(H, 'POST', u, b);

run(async () => {
  const db = await dbConnect();
  const A = await reg('Caja Moneda A');
  await db.query("UPDATE tenants SET plan='pro' WHERE id=$1", [A.id]);
  const today = (await j('/api/cash/2026-01-01', { headers: A.H })).body.today;
  const newOrder = async (total) => (await post(A.H, '/api/orders', { clientName: 'Cliente ' + total, items: [{ name: 'Art', qty: 1, unitPrice: total }] })).body;
  const pay = (id, b) => post(A.H, `/api/orders/${id}/payments`, b);

  const o1 = await newOrder(100), o2 = await newOrder(100), o3 = await newOrder(50), o4 = await newOrder(40);
  await pay(o4.id, { amount: 40, method: 'Efectivo' });                                   // +40 USD (pagado por completo: el reembolso sale de aquí)
  await pay(o1.id, { amount: 30, method: 'Efectivo' });                                   // 30 USD
  await pay(o1.id, { amount: 800, currency: 'VES', exchangeRate: 40, method: 'Efectivo' }); // 800 VES = 20 USD
  await pay(o2.id, { amount: 400, currency: 'VES', exchangeRate: 40, method: 'Efectivo' }); // +400 VES = 10 USD
  await pay(o2.id, { amount: 25, method: 'Zelle' });
  await pay(o3.id, { amount: 1000, currency: 'VES', exchangeRate: 40, method: 'Pago móvil' }); // 1000 VES = 25 USD
  let r = await post(A.H, '/api/expenses', { amount: 200, currency: 'VES', exchangeRate: 40, category: 'Envíos', method: 'Efectivo' }); // −200 VES (5 USD)
  ok(r.status === 200, 'Gasto de 200 VES en efectivo');
  r = await post(A.H, '/api/expenses', { amount: 4, category: 'Otros', method: 'Efectivo' }); // −4 USD
  ok(r.status === 200, 'Gasto de 4 USD en efectivo');
  r = await post(A.H, `/api/orders/${o4.id}/returns`, { reason: 'Devolvió', amount: 6, resolution: 'refund', refundMethod: 'Efectivo' }); // reembolso 6 USD (moneda base)
  ok(r.status === 200, 'Reembolso de 6 USD en efectivo');

  // ── GET: una fila por (método, moneda), con importes originales ──
  r = await j(`/api/cash/${today}`, { headers: A.H });
  const rows = r.body.rows;
  const row = (m, c) => rows.find(x => x.method === m && x.currency === c);
  ok(r.status === 200 && r.body.baseCurrency === 'USD' && Array.isArray(rows), 'GET /api/cash/:day devuelve rows[]');
  ok(rows.filter(x => x.method === 'Efectivo').length === 2, 'Pagos en USD y en VES con el mismo método: DOS filas de Efectivo');
  ok(row('Efectivo', 'USD') && row('Efectivo', 'USD').cobrado === 70 && row('Efectivo', 'USD').reembolsado === 6 && row('Efectivo', 'USD').gastos === 4 && row('Efectivo', 'USD').expected === 60,
    'Efectivo USD: 70 cobrado − 6 reembolsado − 4 gasto = 60');
  ok(row('Efectivo', 'VES') && row('Efectivo', 'VES').cobrado === 1200 && row('Efectivo', 'VES').gastos === 200 && row('Efectivo', 'VES').expected === 1000,
    'Efectivo VES: 800 + 400 cobrado − 200 gasto = 1000 (importes originales en bolívares)');
  ok(row('Zelle', 'USD').expected === 25 && row('Pago Móvil', 'VES').expected === 1000 && rows.length === 4, 'Zelle 25 USD y Pago Móvil 1000 VES; 4 filas en total');
  // Referencia en moneda base: 60 + (1200−200)/40 + 25 + 1000/40 = 60 + 25 + 25 + 25 = 135
  ok(r.body.expectedBase === 135, 'Total de referencia en moneda base = 135');
  ok(rows.every(x => x.counted === undefined && x.difference === undefined), 'Abierta: las filas no traen counted ni difference');

  // ── Cerrar: formato nuevo, una fila contada por (método, moneda) ──
  r = await post(A.H, `/api/cash/${today}/close`, { counted: { Efectivo: 20 } });
  ok(r.status === 400, 'counted como objeto por método (formato antiguo) → 400');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: [{ method: 'Efectivo', currency: 'USD', amount: 60 }, { method: 'Zelle', currency: 'USD', amount: 25 }, { method: 'Pago móvil', currency: 'VES', amount: 1000 }] });
  ok(r.status === 400 && /Falta contar «Efectivo» \(VES\)/.test(r.body.error), 'Falta contar Efectivo en VES (contar el USD no basta) → 400');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: [{ method: 'Efectivo', currency: 'USD', amount: 60 }, { method: 'Efectivo', currency: 'USD', amount: 1 }] });
  ok(r.status === 400 && /repetido/.test(r.body.error), 'Una fila repetida → 400');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: [{ method: 'Efectivo', currency: 'USD', amount: -1 }] });
  ok(r.status === 400, 'Importe negativo → 400');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: [{ method: 'Efectivo', currency: 'US$$', amount: 1 }] });
  ok(r.status === 400, 'Moneda inválida → 400');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: [{ method: 'Saldo a favor', currency: 'USD', amount: 1 }] });
  ok(r.status === 400, 'El saldo a favor no entra en la caja');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: [
    { method: 'Efectivo', currency: 'USD', amount: 59.5 }, { method: 'efectivo', currency: 'ves', amount: 1010 },
    { method: 'Zelle', currency: 'USD', amount: 25 }, { method: 'Pago móvil', currency: 'VES', amount: 1000 }], note: 'Prueba' });
  ok(r.status === 200 && r.body.status === 'closed', 'Cierre con una fila contada por (método, moneda) (nombres y monedas normalizados)');
  const lines = r.body.closing.lines;
  const ln = (m, c) => lines.find(x => x.method === m && x.currency === c);
  ok(ln('Efectivo', 'USD').expected === 60 && ln('Efectivo', 'USD').counted === 59.5 && ln('Efectivo', 'USD').difference === -0.5, 'Efectivo USD: diferencia −0.50');
  ok(ln('Efectivo', 'VES').expected === 1000 && ln('Efectivo', 'VES').counted === 1010 && ln('Efectivo', 'VES').difference === 10, 'Efectivo VES: diferencia +10 (bolívares, no se mezcla con USD)');
  ok(r.body.closing.differentLines === 2, '2 filas con diferencia');
  const saved = (await db.query('SELECT counted, difference FROM cash_closings WHERE tenant_id=$1 AND reopened_at IS NULL', [A.id])).rows[0];
  ok(saved.counted['Efectivo|VES'] === 1010 && saved.counted['Efectivo|USD'] === 59.5 && saved.difference['Efectivo|VES'] === 10, 'Se guarda por clave «método|MONEDA»');
  r = await j(`/api/cash/${today}`, { headers: A.H });
  const e2 = r.body.rows.find(x => x.method === 'Efectivo' && x.currency === 'VES');
  ok(r.body.status === 'closed' && e2.counted === 1010 && e2.difference === 10 && e2.expected === 1000, 'GET con el día cerrado: rows con expected, counted y difference');
  r = await j(`/api/cash?from=${today}&to=${today}`, { headers: A.H });
  ok(r.status === 200 && r.body.baseCurrency === 'USD' && r.body.closings[0].lines.length === 4, 'GET /api/cash lista los cierres con sus filas');

  // ── Cierres antiguos (formato por método, sin moneda) siguen leyéndose, en moneda base ──
  const yest = new Date(Date.parse(today) - 86400000).toISOString().slice(0, 10);
  await db.query(`INSERT INTO cash_closings (tenant_id, day, expected, counted, difference, note, closed_at)
    VALUES ($1, $2::date, $3, $4, $5, 'antiguo', now())`, [A.id, yest, JSON.stringify({ Efectivo: 50, Zelle: 10 }), JSON.stringify({ Efectivo: 48, Zelle: 10 }), JSON.stringify({ Efectivo: -2, Zelle: 0 })]);
  r = await j(`/api/cash/${yest}`, { headers: A.H });
  const old = r.body.closing;
  ok(r.status === 200 && r.body.status === 'closed' && old.lines.length === 2
    && old.lines.find(l => l.method === 'Efectivo').currency === 'USD' && old.lines.find(l => l.method === 'Efectivo').difference === -2,
    'Un cierre antiguo se lee como moneda base (USD)');
  ok(r.body.rows.length === 2 && r.body.rows.find(x => x.method === 'Efectivo').counted === 48, 'GET del día antiguo: rows con lo contado');

  // ── Reabrir y volver a cerrar con moneda base cambiada no aplica: la moneda base queda fija con datos ──
  r = await send(A.H, 'PUT', '/api/tenant/settings', { baseCurrency: 'EUR' });
  ok(r.status === 400 && /moneda base/.test(r.body.error), 'Con cierres, cobros y gastos no se puede cambiar la moneda base');

  await db.query('DELETE FROM tenants WHERE id=$1', [A.id]);
  await db.end();
});
