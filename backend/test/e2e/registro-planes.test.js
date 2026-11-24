// Registro siempre en basic, informes solo desde Pro y mensajes de error en lenguaje de usuario
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const JSONH = { 'Content-Type': 'application/json' };

run(async () => {
  const db = await dbConnect();
  const stamp = Date.now();
  const ids = [];

  // Registro: el plan del body nunca se aplica
  for (const [plan, expected] of [['business', 'business'], ['pro', 'pro'], ['basic', null], [undefined, null], ['hacker', null]]) {
    const r = await j('/api/tenant/register', { method: 'POST', headers: JSONH,
      body: JSON.stringify({ businessName: 'Plan ' + plan, email: `plan${plan}${stamp}@test.local`, password: 'password123', plan }) });
    ok(r.status === 200 && r.body.tenant.plan === 'basic', `Registro con plan ${plan} → cuenta basic`);
    ok(r.body.requestedPlan === expected, `requestedPlan = ${expected} (plan pedido ${plan})`);
    ids.push(r.body.tenant.id);
    const saved = (await db.query('SELECT plan FROM tenants WHERE id=$1', [r.body.tenant.id])).rows[0].plan;
    ok(saved === 'basic', `En la base queda basic (pidió ${plan})`);
  }

  // Informes: 403 en basic, 200 en pro/business
  const A = await reg('Planes A');
  let r = await j('/api/reports?period=hoy', { headers: A.H });
  ok(r.status === 403 && r.body.error === 'plan_required' && /plan Pro/.test(r.body.message), 'Informes en basic → 403 plan_required');
  await db.query(`UPDATE tenants SET plan='pro' WHERE id=$1`, [A.id]);
  r = await j('/api/reports?period=hoy', { headers: A.H });
  ok(r.status === 200, 'Informes en pro → 200 (el plan se lee de la base, no del token)');
  await db.query(`UPDATE tenants SET plan='business' WHERE id=$1`, [A.id]);
  r = await j('/api/reports?period=hoy', { headers: A.H });
  ok(r.status === 200, 'Informes en business → 200');
  await db.query(`UPDATE tenants SET plan='basic' WHERE id=$1`, [A.id]);
  r = await j('/api/reports?period=hoy', { headers: A.H });
  ok(r.status === 403, 'Al bajar a basic con el mismo token → 403');
  await db.query(`UPDATE tenants SET plan='pro' WHERE id=$1`, [A.id]);

  // Demo (plan business): informes siguen funcionando
  const AH = { ...JSONH, Authorization: 'Bearer ' + (await adminToken()), 'X-Demo-Key': DEMO_KEY };
  const demoEmail = 'demoplanes' + stamp + '@test.local';
  const demo = (await j('/api/admin/demos', { method: 'POST', headers: AH, body: JSON.stringify({ email: demoEmail, businessName: 'Demo Planes', days: 3, sendEmail: false }) })).body;
  const dl = (await j('/api/tenant/login', { method: 'POST', headers: JSONH, body: JSON.stringify({ email: demoEmail, password: demo.password }) })).body;
  r = await j('/api/reports?period=hoy', { headers: { Authorization: 'Bearer ' + dl.token } });
  ok(r.status === 200, 'Una demo (plan business) sigue viendo informes');
  ids.push(demo.tenantId);

  // Mensajes en español claro
  r = await send(A.H, 'POST', '/api/orders', { totalPrice: 5 });
  ok(r.status === 400 && r.body.error === 'Falta el nombre del cliente', 'POST pedido sin nombre → "Falta el nombre del cliente"');
  const o = (await send(A.H, 'POST', '/api/orders', { clientName: 'M', items: [{ name: 'X', qty: 1, unitPrice: 1 }] })).body;
  for (const [body, msg] of [
    [{ pay_status: 'x' }, 'Recarga la página: el cobro ahora se registra con «Registrar pago»'],
    [{ delivery_status: 'x' }, 'Estado de entrega inválido'],
    [{ shipping: -1 }, 'Costo de envío inválido'],
    [{ total_price: 'abc' }, 'Total inválido'],
    [{ items: 'x' }, 'La lista de artículos no es válida'],
    [{ foo: 1 }, 'No hay cambios para guardar'],
  ]) {
    r = await send(A.H, 'PATCH', '/api/orders/' + o.id, body);
    ok(r.status === 400 && r.body.error === msg, `PATCH ${JSON.stringify(body)} → "${msg}"`);
  }
  r = await send(A.H, 'POST', '/api/clients', {});
  ok(r.status === 400 && r.body.error === 'Falta el nombre del cliente', 'Cliente sin nombre → mensaje claro');
  r = await send(A.H, 'POST', '/api/catalog', {});
  ok(r.status === 400 && r.body.error === 'Falta el nombre del producto', 'Producto sin nombre → mensaje claro');

  for (const t of [...ids, A.id]) await db.query('DELETE FROM tenants WHERE id=$1', [t]);
  await db.end();
});
