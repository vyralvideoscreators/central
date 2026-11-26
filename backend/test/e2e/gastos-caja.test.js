// Fase 4A: gastos y cierre de caja (bloqueo del día cerrado, esperado por método, reapertura, aislamiento).
const { ok, j, send, reg, db: dbConnect, run } = require('../helpers/harness');
const post = (H, u, b) => send(H, 'POST', u, b);
const TZ = 'America/Caracas';
// Lo contado en el formato nuevo: una fila por método y moneda (USD = moneda base de estos negocios)
const C = (o) => Object.entries(o).map(([method, amount]) => ({ method, currency: /m[oó]vil/i.test(method) ? 'VES' : 'USD', amount }));
const CLOSED = /La caja del \d\d\/\d\d está cerrada/;

run(async () => {
  const db = await dbConnect();
  const A = await reg('Gastos A'), B = await reg('Gastos B');
  await db.query('UPDATE tenants SET timezone=$1, plan=$2 WHERE id = ANY($3)', [TZ, 'pro', [A.id, B.id]]);
  const today = (await db.query(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') d`, [TZ])).rows[0].d;
  const dayShift = (d, k) => new Date(Date.parse(d) + k * 86400000).toISOString().slice(0, 10);
  const yesterday = dayShift(today, -1), tomorrow = dayShift(today, 1);
  const newOrder = async (H, total) => (await post(H, '/api/orders', { clientName: 'Cliente ' + total, items: [{ name: 'Art', qty: 1, unitPrice: total }] })).body;
  const pay = (H, id, b) => post(H, `/api/orders/${id}/payments`, b);

  // ── Gastos: validaciones y alta ──
  let r = await j('/api/expenses', { headers: A.H });
  ok(r.status === 200 && r.body.expenses.length === 0 && r.body.total === 0 && r.body.categories.length === 7 && r.body.categories[0] === 'Compras de mercancía', 'Gastos vacíos con las 7 categorías por defecto');
  r = await post(A.H, '/api/expenses', { amount: 10, category: 'Envíos' });
  ok(r.status === 400 && /Método/.test(r.body.error), 'Sin método → 400');
  r = await post(A.H, '/api/expenses', { amount: 10, category: 'Inventada', method: 'Efectivo' });
  ok(r.status === 400 && /Categoría/.test(r.body.error), 'Categoría fuera de la lista → 400');
  r = await post(A.H, '/api/expenses', { amount: 0, category: 'Envíos', method: 'Efectivo' });
  ok(r.status === 400, 'Monto 0 → 400');
  r = await post(A.H, '/api/expenses', { amount: 10, category: 'Envíos', method: 'Efectivo', spentOn: tomorrow });
  ok(r.status === 400 && /futura/.test(r.body.error), 'Fecha futura → 400');
  r = await post(A.H, '/api/expenses', { amount: 10, category: 'Envíos', method: 'Saldo a favor' });
  ok(r.status === 400, 'Un gasto no se paga con saldo a favor');
  r = await post(A.H, '/api/expenses', { amount: 10, currency: 'VES', category: 'Envíos', method: 'Efectivo' });
  ok(r.status === 400 && /tasa/.test(r.body.error), 'Moneda extranjera sin tasa → 400');
  r = await post(A.H, '/api/expenses', { amount: 20, category: 'envios', method: 'efectivo $', note: 'Moto' });
  ok(r.status === 200 && r.body.expense.category === 'Envíos' && r.body.expense.method === 'Efectivo' && r.body.expense.amountBase === 20 && r.body.expense.spentOn === today, 'Gasto de 20: categoría con la forma de la lista, método canónico, día de hoy');
  const e1 = r.body.expense;
  r = await post(A.H, '/api/expenses', { amount: 400, currency: 'ves', exchangeRate: 40, category: 'Servicios', method: 'Pago móvil' });
  ok(r.status === 200 && r.body.expense.currency === 'VES' && r.body.expense.amountBase === 10 && r.body.expense.exchangeRate === 40, 'Gasto en bolívares: 400 VES a tasa 40 = 10 en moneda base');
  const e2 = r.body.expense;
  r = await post(A.H, '/api/expenses', { amount: 5, category: 'Otros', method: 'Efectivo', spentOn: yesterday });
  ok(r.status === 200 && r.body.expense.spentOn === yesterday, 'Gasto de ayer');
  const e3 = r.body.expense;

  r = await j('/api/expenses?period=7d', { headers: A.H });
  ok(r.body.total === 35 && r.body.byCategory.length === 3 && r.body.byCategory[0].category === 'Envíos' && r.body.byCategory[0].total === 20, 'Total 35 y total por categoría');
  r = await j('/api/expenses?period=today', { headers: A.H });
  ok(r.body.total === 30 && r.body.expenses.length === 2, 'Periodo hoy: 30 (el de ayer queda fuera)');
  r = await j('/api/expenses?period=7d&category=servicios', { headers: A.H });
  ok(r.body.total === 10 && r.body.expenses.length === 1, 'Filtro por categoría (sin distinguir mayúsculas)');
  r = await j('/api/expenses?period=raro', { headers: A.H });
  ok(r.status === 400, 'Periodo inválido → 400');

  // ── Anular ──
  r = await post(A.H, `/api/expenses/${e3.id}/void`, {});
  ok(r.status === 400, 'Anular sin motivo → 400');
  r = await post(A.H, `/api/expenses/${e3.id}/void`, { reason: 'Duplicado' });
  ok(r.status === 200 && r.body.expense.voided === true && r.body.expense.voidReason === 'Duplicado', 'Gasto anulado con motivo');
  r = await post(A.H, `/api/expenses/${e3.id}/void`, { reason: 'otra vez' });
  ok(r.status === 400 && /ya fue anulado/.test(r.body.error), 'Anular dos veces → 400');
  r = await j('/api/expenses?period=7d', { headers: A.H });
  ok(r.body.total === 30 && r.body.expenses.length === 3 && r.body.expenses.some(e => e.voided), 'Los anulados salen en la lista pero no suman');
  const n = (await db.query('SELECT COUNT(*)::int n FROM expenses WHERE tenant_id=$1', [A.id])).rows[0].n;
  ok(n === 3, 'Nada se borra: anular no elimina la fila');
  r = await post(A.H, '/api/expenses/no-es-uuid/void', { reason: 'x' });
  ok(r.status === 404, 'Id que no es UUID → 404');

  // ── Aislamiento ──
  r = await j('/api/expenses?period=7d', { headers: B.H });
  ok(r.status === 200 && r.body.expenses.length === 0 && r.body.total === 0, 'Otro negocio no ve los gastos');
  r = await post(B.H, `/api/expenses/${e1.id}/void`, { reason: 'intruso' });
  ok(r.status === 404, 'Otro negocio no puede anular un gasto ajeno');
  ok((await db.query('SELECT voided_at FROM expenses WHERE id=$1', [e1.id])).rows[0].voided_at === null, '… y el gasto sigue vigente');

  // ── Categorías editables ──
  r = await send(A.H, 'PUT', '/api/tenant/settings', { expenseCategories: [] });
  ok(r.status === 400, 'Lista de categorías vacía → 400');
  r = await send(A.H, 'PUT', '/api/tenant/settings', { expenseCategories: ['Café', 'cafe'] });
  ok(r.status === 400, 'Categorías repetidas (sin acentos) → 400');
  r = await send(A.H, 'PUT', '/api/tenant/settings', { expenseCategories: Array.from({ length: 31 }, (_, i) => 'C' + i) });
  ok(r.status === 400, 'Más de 30 categorías → 400');
  r = await send(A.H, 'PUT', '/api/tenant/settings', { expenseCategories: ['Café', 'Envíos', 'Otros'] });
  ok(r.status === 200 && r.body.expenseCategories.join() === 'Café,Envíos,Otros', 'Categorías guardadas');
  r = await j('/api/tenant/settings', { headers: A.H });
  ok(r.body.expenseCategories.join() === 'Café,Envíos,Otros' && r.body.paymentMethods !== undefined, 'GET ajustes devuelve las categorías');
  r = await post(A.H, '/api/expenses', { amount: 3, category: 'Servicios', method: 'Efectivo' });
  ok(r.status === 400, 'Una categoría quitada de la lista ya no se admite en gastos nuevos');
  r = await j('/api/expenses?period=7d', { headers: A.H });
  ok(r.body.total === 30, 'Los gastos viejos conservan su categoría');
  r = await j('/api/tenant/settings', { headers: B.H });
  ok(r.body.expenseCategories.length === 7, 'Otro negocio sigue con la lista por defecto');

  // ── Cierre de caja: esperado correcto ──
  const o1 = await newOrder(A.H, 100), o2 = await newOrder(A.H, 80), o3 = await newOrder(A.H, 50), o4 = await newOrder(A.H, 40);
  await pay(A.H, o1.id, { amount: 60, method: 'Efectivo' });
  const p1b = (await pay(A.H, o1.id, { amount: 30, method: 'Zelle' })).body.payment;
  await pay(A.H, o2.id, { amount: 80, method: 'Efectivo' });
  r = await post(A.H, `/api/orders/${o2.id}/returns`, { reason: 'Devolvió uno', amount: 10, resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200, 'Devolución con reembolso de 10 en efectivo (antes de cerrar)');
  r = await j(`/api/cash/${today}`, { headers: A.H });
  const byM = Object.fromEntries(r.body.rows.map(m => [m.method, m]));
  ok(r.status === 200 && r.body.status === 'open' && r.body.day === today && r.body.isFuture === false, 'GET caja de hoy: abierta');
  // Efectivo: cobros 60+80 = 140, reembolsos 10, gastos 20 → 110. Zelle: 30. Pago Móvil: gasto 10 → −10
  ok(byM['Efectivo'] && byM['Efectivo'].cobrado === 140 && byM['Efectivo'].reembolsado === 10 && byM['Efectivo'].gastos === 20 && byM['Efectivo'].expected === 110 && byM['Efectivo'].currency === 'USD', 'Esperado en Efectivo = 140 − 10 − 20 = 110');
  ok(byM['Zelle'] && byM['Zelle'].expected === 30, 'Esperado en Zelle = 30');
  ok(byM['Pago Móvil'] && byM['Pago Móvil'].expected === -400 && byM['Pago Móvil'].currency === 'VES' && r.body.expectedBase === 130, 'Pago Móvil: solo un gasto de 400 VES (−400 en VES, 10 en base); total en base 130');
  ok(!r.body.rows.some(m => m.method === 'Saldo a favor'), 'El saldo a favor no entra en la caja');
  r = await j(`/api/cash/${yesterday}`, { headers: A.H });
  ok(r.body.rows.length === 0 || r.body.rows.every(m => m.method !== 'Efectivo' || m.expected === 0), 'Ayer: sin movimientos de caja (el gasto de ayer está anulado)');
  r = await j('/api/cash/2026-13-45', { headers: A.H });
  ok(r.status === 400, 'Día inválido → 400');

  // ── Cerrar ──
  r = await post(A.H, `/api/cash/${tomorrow}/close`, { counted: [] });
  ok(r.status === 400 && /futuro/.test(r.body.error), 'No se puede cerrar un día futuro');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: C({ Efectivo: 110 }) });
  ok(r.status === 400 && /Falta contar/.test(r.body.error), 'Falta contar un método con movimiento → 400');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: C({ Efectivo: -1e9, Zelle: 30, 'Pago móvil': 0 }) });
  ok(r.status === 400, 'Importe contado fuera de rango → 400');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: C({ Efectivo: 108.5, Zelle: 30, 'Pago móvil': 0 }), note: 'Faltó cambio' });
  ok(r.status === 200 && r.body.status === 'closed', 'Caja cerrada');
  const cl = r.body.closing;
  const lineE = cl.lines.find(l => l.method === 'Efectivo'), lineP = cl.lines.find(l => l.method === 'Pago Móvil');
  ok(lineE.expected === 110 && lineE.counted === 108.5 && lineE.difference === -1.5, 'Diferencia de Efectivo = −1.50');
  ok(lineP.currency === 'VES' && lineP.expected === -400 && lineP.counted === 0 && lineP.difference === 400, 'Pago Móvil (VES): esperado −400, contado 0');
  ok(cl.differentLines === 2 && cl.note === 'Faltó cambio', 'Diferencia total y nota guardadas');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: C({ Efectivo: 110, Zelle: 30, 'Pago Móvil': -10 }) });
  ok(r.status === 400 && /ya está cerrada/.test(r.body.error), 'Cerrar el mismo día dos veces → 400');
  ok((await db.query('SELECT COUNT(*)::int n FROM cash_closings WHERE tenant_id=$1', [A.id])).rows[0].n === 1, '… y no queda una segunda fila');

  // ── Con el día cerrado ──
  r = await pay(A.H, o3.id, { amount: 10, method: 'Efectivo' });
  ok(r.status === 400 && (r.body.error === 'cash_closed' && CLOSED.test(r.body.message)), 'Cobrar en un día cerrado → 400 «La caja del DD/MM está cerrada»');
  r = await pay(A.H, o3.id, { amount: 10, method: 'Efectivo', paidAt: yesterday });
  ok(r.status === 200, 'Un cobro con fecha de ayer sí se registra (otro día, abierto)');
  const pY = r.body.payment;
  r = await post(A.H, `/api/payments/${p1b.id}/void`, { reason: 'error' });
  ok(r.status === 400 && (r.body.error === 'cash_closed' && CLOSED.test(r.body.message)), 'Anular un pago del día cerrado → 400');
  ok((await db.query('SELECT voided_at FROM payments WHERE id=$1', [p1b.id])).rows[0].voided_at === null, '… y el pago sigue vigente');
  r = await post(A.H, `/api/payments/${pY.id}/void`, { reason: 'error de ayer' });
  ok(r.status === 200, 'Anular el pago de ayer sí se puede');
  r = await post(A.H, `/api/orders/${o2.id}/returns`, { reason: 'otra', amount: 5, resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400 && (r.body.error === 'cash_closed' && CLOSED.test(r.body.message)), 'Devolución con reembolso de dinero → 400');
  const ord2 = (await j('/api/orders', { headers: A.H })).body.find(o => o.id === o2.id);
  ok(ord2.creditedTotal === 10, '… y la nota de crédito no quedó a medias (transacción)');
  r = await post(A.H, `/api/orders/${o2.id}/cancel`, { reason: 'x', resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 400 && (r.body.error === 'cash_closed' && CLOSED.test(r.body.message)), 'Anular un pedido con dinero cobrado → 400');
  ok((await j('/api/orders', { headers: A.H })).body.find(o => o.id === o2.id).cancelled === false, '… y el pedido sigue sin anular');
  r = await post(A.H, `/api/orders/${o4.id}/cancel`, { reason: 'Sin cobros' });
  ok(r.status === 200, 'Anular un pedido sin dinero sí se puede (no mueve la caja)');
  r = await post(A.H, '/api/expenses', { amount: 1, category: 'Envíos', method: 'Efectivo' });
  ok(r.status === 400 && (r.body.error === 'cash_closed' && CLOSED.test(r.body.message)), 'Gasto de hoy en día cerrado → 400');
  r = await post(A.H, `/api/expenses/${e1.id}/void`, { reason: 'x' });
  ok(r.status === 400 && (r.body.error === 'cash_closed' && CLOSED.test(r.body.message)), 'Anular un gasto del día cerrado → 400');
  r = await post(A.H, '/api/expenses', { amount: 1, category: 'Envíos', method: 'Efectivo', spentOn: yesterday });
  ok(r.status === 200, 'Gasto de otro día (ayer) sí');
  r = await post(A.H, '/api/orders', { clientName: 'Nuevo', items: [{ name: 'Art', qty: 1, unitPrice: 20 }], initialPayment: { amount: 20, method: 'Efectivo' } });
  ok(r.status === 400 && (r.body.error === 'cash_closed' && CLOSED.test(r.body.message)), 'Pedido con pago inicial en día cerrado → 400');
  ok((await db.query(`SELECT COUNT(*)::int n FROM orders WHERE tenant_id=$1 AND client_name='Nuevo'`, [A.id])).rows[0].n === 0, '… y el pedido no se crea (todo o nada)');
  r = await post(A.H, '/api/orders', { clientName: 'Nuevo', items: [{ name: 'Art', qty: 1, unitPrice: 20 }] });
  ok(r.status === 200, 'Crear un pedido sin cobro no se bloquea');

  // ── Aislamiento del cierre ──
  r = await j(`/api/cash/${today}`, { headers: B.H });
  ok(r.body.status === 'open' && r.body.rows.length === 0 && r.body.history.length === 0, 'El otro negocio ve su caja abierta y vacía');
  const ob = await newOrder(B.H, 10);
  r = await pay(B.H, ob.id, { amount: 10, method: 'Efectivo' });
  ok(r.status === 200, 'El otro negocio sigue cobrando');
  r = await post(B.H, `/api/cash/${today}/reopen`, { reason: 'intruso' });
  ok(r.status === 400, 'El otro negocio no puede reabrir (no tiene cierre)');
  ok((await j(`/api/cash/${today}`, { headers: A.H })).body.status === 'closed', '… y la caja de A sigue cerrada');

  // ── Reabrir ──
  r = await post(A.H, `/api/cash/${today}/reopen`, {});
  ok(r.status === 400, 'Reabrir sin motivo → 400');
  r = await post(A.H, `/api/cash/${today}/reopen`, { reason: 'Faltaba un cobro' });
  ok(r.status === 200 && r.body.status === 'open' && r.body.closing === null && r.body.history.length === 1 && r.body.history[0].status === 'reopened' && r.body.history[0].reopenReason === 'Faltaba un cobro', 'Reabierta: queda en el historial con su motivo');
  r = await post(A.H, `/api/cash/${today}/reopen`, { reason: 'otra' });
  ok(r.status === 400 && /no está cerrada/.test(r.body.error), 'Reabrir un día abierto → 400');
  r = await pay(A.H, o3.id, { amount: 10, method: 'Efectivo' });
  ok(r.status === 200, 'Reabierta la caja, cobrar vuelve a funcionar');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: C({ Efectivo: 120, Zelle: 30, 'Pago móvil': -1e9 }) });
  ok(r.status === 400, 'Contado fuera de rango en un método → 400');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: C({ Efectivo: 120, Zelle: 30, 'Pago móvil': 0 }) });
  ok(r.status === 200 && r.body.history.length === 2 && r.body.closing.lines.find(l => l.method === 'Efectivo').expected === 120, 'Se vuelve a cerrar con el cobro nuevo (esperado 120): dos filas de historial');
  r = await j(`/api/cash?from=${yesterday}&to=${today}`, { headers: A.H });
  ok(r.status === 200 && r.body.closings.length === 2 && r.body.closings.filter(c => c.status === 'closed').length === 1, 'GET /api/cash lista los cierres (uno vigente, uno reabierto)');
  r = await post(A.H, `/api/cash/${today}/reopen`, { reason: 'para la prueba de concurrencia' });

  // ── Cerrar y cobrar a la vez: o bien el cobro entra en lo esperado, o el cobro es rechazado ──
  const o5 = await newOrder(A.H, 500);
  const [rc, rp] = await Promise.all([
    post(A.H, `/api/cash/${today}/close`, { counted: C({ Efectivo: 9999, Zelle: 9999, 'Pago móvil': 0 }) }),
    pay(A.H, o5.id, { amount: 77, method: 'Efectivo' }),
  ]);
  const closing = (await db.query(`SELECT expected FROM cash_closings WHERE tenant_id=$1 AND day=$2 AND reopened_at IS NULL`, [A.id, today])).rows[0];
  const paidNow = Number((await db.query(`SELECT COALESCE(SUM(amount_base),0) s FROM payments WHERE tenant_id=$1 AND method='Efectivo' AND voided_at IS NULL AND paid_at >= (($2::date)::timestamp AT TIME ZONE $3)`, [A.id, today, TZ])).rows[0].s);
  const refundedNow = Number((await db.query(`SELECT COALESCE(SUM(amount_base),0) s FROM refunds WHERE tenant_id=$1 AND method='Efectivo'`, [A.id])).rows[0].s);
  const expCash = closing ? Number(closing.expected['Efectivo|USD']) : null;
  ok(rc.status === 200 && closing, 'Cerrar a la vez que se cobra: la caja queda cerrada');
  ok((rp.status === 200 && expCash === paidNow - refundedNow - 20) || (rp.status === 400 && (rp.body.error === 'cash_closed' && CLOSED.test(rp.body.message)) && expCash === paidNow - refundedNow - 20),
    'El cobro simultáneo o entra en el esperado o es rechazado: nunca queda fuera del cierre (esperado ' + expCash + ', cobros ' + paidNow + ')');

  await db.end();
});
