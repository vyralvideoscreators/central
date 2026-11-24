// Regresión de demos tras los 8 cambios
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, metaCalls, clearMeta, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const B = process.env.BASE_URL;
const post = (H, u, b) => send(H, 'POST', u, b);

run(async () => {
  const db = await dbConnect();
  const adm = await adminToken();
  const AH = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + adm, 'X-Demo-Key': DEMO_KEY };
  const email = 'demo' + Date.now() + '@test.local';
  const demo = (await j('/api/admin/demos', { method: 'POST', headers: AH, body: JSON.stringify({ email, businessName: 'Demo Regresión', days: 3, sendEmail: false }) })).body;
  ok(!!demo.tenantId, 'Demo creada');
  const login = (await j('/api/tenant/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: demo.password }) })).body;
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + login.token };
  clearMeta();

  // /app inyecta el plan de la demo
  const html = await fetch(B + '/app?token=' + login.token).then(r => r.text());
  ok(/__TENANT_PLAN__="business"/.test(html) && /__DEMO_MODE__=true/.test(html), '/app: plan business + modo demo');

  // Ticket por Instagram en demo: simulado, nunca sale a Meta
  let r = await j('/api/send-ticket', { method: 'POST', headers: H, body: JSON.stringify({ igId: '9988', ticketHtml: '<b>x</b>', caption: 'Presupuesto' }) });
  ok(r.status === 200 && r.body.demo === true, 'Demo: ticket por Instagram simulado');
  const conv = (await db.query(`SELECT platform FROM conversations WHERE tenant_id=$1 AND wa_id='ig_9988'`, [demo.tenantId])).rows[0];
  ok(conv && conv.platform === 'ig', 'Demo: el ticket queda en la conversación de Instagram');
  r = await j('/api/send-ticket', { method: 'POST', headers: H, body: JSON.stringify({ waId: '58414', ticketHtml: '<b>x</b>' }) });
  ok(r.status === 200 && r.body.demo === true, 'Demo: ticket por WhatsApp simulado');
  ok(metaCalls().length === 0, 'Demo: ninguna llamada a Meta');

  // Pedidos, edición y fichas en demo
  const orders = (await j('/api/orders', { headers: H })).body;
  ok(orders.length > 0, 'Demo: tiene pedidos de ejemplo');
  const linked = orders.filter(o => o.clientId).length;
  ok(linked > 0, `Demo: pedidos de ejemplo vinculados a su ficha (${linked}/${orders.length})`);
  r = await j('/api/orders/' + orders[0].id, { method: 'PATCH', headers: H, body: JSON.stringify({ notes: 'editado en demo', items: [{ name: 'A', qty: 1, unitPrice: 1 }] }) });
  ok(r.status === 200 && r.body.notes === 'editado en demo', 'Demo: puede editar un pedido');
  r = await j('/api/orders/' + orders[0].id, { method: 'PATCH', headers: H, body: JSON.stringify({ items: Array.from({ length: 31 }, () => ({ name: 'A', qty: 1, unitPrice: 1 })) }) });
  ok(r.status === 400 && r.body.error === 'demo_limit', 'Demo: máximo 30 artículos también al editar');
  r = await j('/api/orders', { method: 'POST', headers: H, body: JSON.stringify({ clientName: 'Nueva demo', clientConvoKey: 'ig_9988', items: [{ name: 'A', qty: 1, unitPrice: 2 }] }) });
  ok(r.status === 200 && r.body.createdClient, 'Demo: pedido de chat sin ficha crea la ficha');

  // Informes en demo
  r = await j('/api/reports?period=año', { headers: H });
  ok(r.status === 200 && r.body.pedidos > 0, 'Demo: informes del servidor funcionan');

  // La imagen temporal no es accesible para rutas bloqueadas; y rutas no permitidas siguen bloqueadas
  r = await j('/api/tenant/whatsapp', { method: 'PUT', headers: H, body: JSON.stringify({ whatsapp_phone_number_id: '1', whatsapp_token: 'x' }) });
  ok(r.status === 403 && r.body.error === 'demo_blocked', 'Demo: conectar WhatsApp sigue bloqueado');

  // Hacer real: borra todo (incluidas fichas creadas por pedidos)
  await j(`/api/admin/demos/${demo.tenantId}/convert`, { method: 'POST', headers: AH });
  const left = (await db.query(`SELECT (SELECT COUNT(*) FROM orders WHERE tenant_id=$1)::int o, (SELECT COUNT(*) FROM clients WHERE tenant_id=$1)::int c`, [demo.tenantId])).rows[0];
  ok(left.o === 0 && left.c === 0, 'Hacer real: la cuenta queda vacía');

  await db.query('DELETE FROM tenants WHERE id=$1', [demo.tenantId]);
  await db.end();
});
