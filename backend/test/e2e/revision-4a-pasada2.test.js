// Fase 4A, segunda pasada de revisión: admin sin país, contado negativo, reabrir en plan Básico, cash_closed,
// fecha de pago futura, moneda base con pedidos y relleno de pagos antiguos frente a un día cerrado.
const { ok, j, send, reg, db: dbConnect, run, adminToken } = require('../helpers/harness');
const ops = require('../../operacion');
const pagos = require('../../pagos');
const post = (H, u, b) => send(H, 'POST', u, b);
const TZ = 'America/Caracas';

run(async () => {
  const db = await dbConnect();
  const adm = await adminToken();
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm };
  const dayShift = (d, k) => new Date(Date.parse(d) + k * 86400000).toISOString().slice(0, 10);

  // ═══ 1) Panel admin: un negocio SIN país puede editar otros campos ═══
  const N = await reg('Sin Pais');
  await db.query('UPDATE tenants SET country = NULL, timezone = $2 WHERE id = $1', [N.id, TZ]);
  let r = await send(AH, 'PUT', `/api/admin/tenants/${N.id}`, { email: 'nuevo' + Date.now() + '@test.local', country: '' });
  ok(r.status === 200 && r.body.success, 'Admin: editar el correo de un negocio sin país (country vacío = sin cambio)');
  r = await send(AH, 'PUT', `/api/admin/tenants/${N.id}`, { whatsapp_token: 'tok_prueba', country: null });
  ok(r.status === 200, 'Admin: editar el token de un negocio sin país (country null = sin cambio)');
  r = await send(AH, 'PUT', `/api/admin/tenants/${N.id}`, { business_name: 'Sin Pais 2' });
  ok(r.status === 200 && r.body.tenant.business_name === 'Sin Pais 2', 'Admin: sin enviar country también funciona');
  r = await send(AH, 'PUT', `/api/admin/tenants/${N.id}`, { country: 'Narnia' });
  ok(r.status === 400, 'Admin: un país que no está en la lista sigue dando 400');
  r = await send(AH, 'PUT', `/api/admin/tenants/${N.id}`, { country: 'Colombia' });
  ok(r.status === 200 && r.body.tenant.country === 'Colombia' && r.body.tenant.timezone === 'America/Bogota', 'Admin: asignar un país válido fija su zona');

  // ═══ 2) Cierre con esperado negativo: se cuadra contando en negativo ═══
  const A = await reg('Pasada Dos');
  await db.query('UPDATE tenants SET timezone=$1, plan=$2 WHERE id=$3', [TZ, 'pro', A.id]);
  const today = (await db.query(`SELECT to_char(now() AT TIME ZONE $1, 'YYYY-MM-DD') d`, [TZ])).rows[0].d;
  const yesterday = dayShift(today, -1), tomorrow = dayShift(today, 1);
  const o1 = (await post(A.H, '/api/orders', { clientName: 'Ana', items: [{ name: 'Art', qty: 1, unitPrice: 20 }] })).body;
  r = await post(A.H, `/api/orders/${o1.id}/payments`, { amount: 20, method: 'Efectivo', paidAt: yesterday });
  ok(r.status === 200, 'Cobro de ayer en efectivo');
  r = await post(A.H, `/api/orders/${o1.id}/returns`, { reason: 'Devolvió', amount: 5, resolution: 'refund', refundMethod: 'Efectivo' });
  ok(r.status === 200, 'Reembolso de 5 en efectivo hoy');
  r = await j(`/api/cash/${today}`, { headers: A.H });
  const ef = r.body.rows.find(x => x.method === 'Efectivo');
  ok(ef && ef.cobrado === 0 && ef.reembolsado === 5 && ef.expected === -5, 'Hoy el esperado en efectivo es −5 (solo un reembolso)');
  r = await post(A.H, `/api/cash/${today}/close`, { counted: [{ method: 'Efectivo', currency: 'USD', amount: -5 }] });
  ok(r.status === 200 && r.body.status === 'closed', 'Se cierra contando −5');
  const line = r.body.closing.lines.find(l => l.method === 'Efectivo');
  ok(line && line.expected === -5 && line.counted === -5 && line.difference === 0 && r.body.closing.differentLines === 0, 'Contado −5, diferencia 0');
  // un importe absurdo sigue rechazado
  r = await post(A.H, `/api/cash/${yesterday}/close`, { counted: [{ method: 'Efectivo', currency: 'USD', amount: -1e9 }] });
  ok(r.status === 400, 'Un contado fuera de rango da 400');

  // ═══ 5) Código de caja cerrada ═══
  const o2 = (await post(A.H, '/api/orders', { clientName: 'Beto', items: [{ name: 'Art', qty: 1, unitPrice: 30 }] })).body;
  r = await post(A.H, `/api/orders/${o2.id}/payments`, { amount: 10, method: 'Efectivo' });
  ok(r.status === 400 && r.body.error === 'cash_closed' && /Gastos → Cierre de caja/.test(r.body.message) && !/Ajustes → Ubicación/.test(r.body.message),
    'Cobrar en un día cerrado: error "cash_closed" y mensaje que dice dónde reabrir');

  // ═══ 3) Plan Básico con cierre vigente: puede ver y reabrir ═══
  await db.query('UPDATE tenants SET plan=$2 WHERE id=$1', [A.id, 'basic']);
  r = await j('/api/cash', { headers: A.H });
  ok(r.status === 403 && r.body.error === 'plan_required', 'Básico: la caja sigue siendo de Pro (403)');
  r = await j('/api/cash-closed', { headers: A.H });
  ok(r.status === 200 && r.body.days.length === 1 && r.body.days[0].day === today, 'Básico: lista sus días cerrados');
  r = await post(A.H, `/api/cash/${today}/reopen`, {});
  ok(r.status === 400, 'Básico: reabrir sin motivo → 400');
  r = await post(A.H, `/api/cash/${today}/reopen`, { reason: 'Bajé de plan' });
  ok(r.status === 200 && r.body.status === 'open', 'Básico: reabre el día cerrado');
  r = await j('/api/cash-closed', { headers: A.H });
  ok(r.status === 200 && r.body.days.length === 0, 'Básico: ya no quedan días cerrados');
  r = await post(A.H, `/api/orders/${o2.id}/payments`, { amount: 10, method: 'Efectivo' });
  ok(r.status === 200, 'Básico: tras reabrir, vuelve a poder cobrar');
  const B = await reg('Otro Negocio');
  r = await j('/api/cash-closed', { headers: B.H });
  ok(r.status === 200 && r.body.days.length === 0, 'La lista de días cerrados es de cada negocio');

  // ═══ 12) Pago con fecha futura ═══
  r = await post(A.H, `/api/orders/${o2.id}/payments`, { amount: 5, method: 'Efectivo', paidAt: tomorrow });
  ok(r.status === 400 && /futura/.test(r.body.error), 'Pago fechado mañana → 400');
  r = await post(A.H, `/api/orders/${o2.id}/payments`, { amount: 5, method: 'Efectivo', paidAt: today });
  ok(r.status === 200, 'Pago fechado hoy → 200');
  r = await post(A.H, `/api/orders/${o2.id}/payments`, { amount: 5, method: 'Efectivo', paidAt: new Date(Date.now() + 20 * 3600000).toISOString().slice(0, 19) + 'Z' });
  const sameDay = (await db.query(`SELECT to_char((now() + interval '20 hours') AT TIME ZONE $1, 'YYYY-MM-DD') d`, [TZ])).rows[0].d === today;
  ok(sameDay ? r.status === 200 : (r.status === 400 && /futura/.test(r.body.error)), 'Un instante posterior al día de hoy del negocio → 400 (el mismo día no)');

  // ═══ 13) Moneda base: bloqueada si hay pedidos con total ═══
  const C = await reg('Moneda Pedidos');
  r = await j('/api/tenant/settings', { headers: C.H });
  ok(r.body.canChangeBaseCurrency === true, 'Sin pedidos, la moneda base se puede cambiar');
  await post(C.H, '/api/orders', { clientName: 'Cami', items: [{ name: 'Art', qty: 1, unitPrice: 12 }] });
  r = await j('/api/tenant/settings', { headers: C.H });
  ok(r.body.canChangeBaseCurrency === false, 'Con un pedido con total, la moneda base queda fija');
  r = await send(C.H, 'PUT', '/api/tenant/settings', { baseCurrency: 'VES' });
  ok(r.status === 400 && /moneda base/.test(r.body.error) && /pedidos con total/.test(r.body.error), 'Cambiar la moneda base con pedidos → 400 con mensaje claro');

  // ═══ 10) closingLines: la moneda tras el último «|» solo cuenta si tiene forma de moneda ═══
  const L = ops.closingLines({ expected: { 'Efectivo|USD': 1, 'Pago|raro método': 2, 'Zelle': 3 }, counted: {}, difference: {} }, 'EUR');
  const by = Object.fromEntries(L.map(l => [l.method, l.currency]));
  ok(by['Efectivo'] === 'USD' && by['Pago|raro método'] === 'EUR' && by['Zelle'] === 'EUR', 'closingLines: sin moneda válida, toda la clave es el método (en moneda base)');

  // ═══ 11) Relleno de pagos antiguos: respeta un día cerrado aunque la zona se derive del país ═══
  const D = await reg('Relleno Cerrado');
  await db.query('UPDATE tenants SET plan=$2, timezone=NULL, country=$3 WHERE id=$1', [D.id, 'pro', 'Venezuela']); // zona efectiva por país (tzOf)
  const od = (await post(D.H, '/api/orders', { clientName: 'Dani', items: [{ name: 'Art', qty: 1, unitPrice: 15 }] })).body;
  await db.query(`UPDATE orders SET pay_status='ok', amount_paid=0 WHERE id=$1`, [od.id]); // «pagado a la antigua»
  r = await post(D.H, `/api/cash/${today}/close`, { counted: [] });
  ok(r.status === 200, 'Día cerrado sin movimientos');
  const batch = async () => { await db.query('BEGIN'); try { const n = await pagos.backfillLegacyPayments(db, 50); await db.query('COMMIT'); return n; } catch (e) { await db.query('ROLLBACK'); throw e; } };
  const countOd = async () => (await db.query('SELECT COUNT(*)::int n FROM payments WHERE order_id=$1', [od.id])).rows[0].n;
  await batch();
  ok((await countOd()) === 0, 'El relleno no crea un pago dentro de un día cerrado (zona derivada del país)');
  r = await post(D.H, `/api/cash/${today}/reopen`, { reason: 'prueba' });
  ok(r.status === 200, 'Se reabre el día');
  await batch();
  ok((await countOd()) === 1, 'Reabierto el día, el relleno sí lo recoge');

  await db.end();
});
