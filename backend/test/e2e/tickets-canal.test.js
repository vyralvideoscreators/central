// Fallo 2: tickets por canal correcto. Necesita el servidor de pruebas (Meta simulada) en :3999
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, metaCalls, clearMeta, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const B = process.env.BASE_URL;
const post = (H, u, b) => send(H, 'POST', u, b);
const ticketHtml = '<div class="ticket-body"><div class="ticket-row"><span class="ticket-row-label">Cliente</span><span class="ticket-row-value">Prueba</span></div></div>';

run(async () => {
  const db = await dbConnect();
  const email = 'ig' + Date.now() + '@test.local';
  const reg = await j('/api/tenant/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ businessName: 'Tienda IG', email, password: 'password123' }) });
  const tok = reg.body.token, tid = reg.body.tenant.id;
  await db.query(`UPDATE tenants SET instagram_access_token='fake_ig', whatsapp_phone_number_id='111', whatsapp_token='fake_wa' WHERE id=$1`, [tid]);
  const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
  clearMeta();

  // 1) Instagram: imagen por enlace + texto aparte
  let r = await j('/api/send-ticket', { method: 'POST', headers: H, body: JSON.stringify({ igId: '178414', ticketHtml, caption: '📋 Presupuesto', orderType: 'presupuesto' }) });
  ok(r.status === 200 && r.body.success, 'IG: send-ticket responde OK (' + r.status + ' ' + JSON.stringify(r.body && r.body.error) + ')');
  const calls = metaCalls();
  const img = calls.find(c => c.body && c.body.message && c.body.message.attachment);
  ok(!!img && /graph\.instagram\.com/.test(img.url) && img.body.recipient.id === '178414', 'IG: imagen enviada a Instagram al destinatario correcto');
  ok(!calls.some(c => /graph\.facebook\.com/.test(c.url)), 'IG: nada sale por WhatsApp');
  ok(calls.some(c => c.body && c.body.message && c.body.message.text === '📋 Presupuesto'), 'IG: el texto va aparte');
  const url = img.body.message.attachment.payload.url;
  ok(/^http:\/\/localhost:\d+\/api\/ticket-image\/[0-9a-f]{64}$/.test(url), 'IG: enlace aleatorio de 64 hex');
  const pic = await fetch(url);
  const buf = Buffer.from(await pic.arrayBuffer());
  ok(pic.status === 200 && pic.headers.get('content-type') === 'image/png' && buf.slice(1, 4).toString() === 'PNG', 'IG: el enlace sirve un PNG sin sesión');
  ok((await fetch(B + '/api/ticket-image/' + 'a'.repeat(64))).status === 404, 'IG: enlace inventado → 404');
  const msgs = (await db.query(`SELECT type, text, media_url FROM messages WHERE tenant_id=$1 AND wa_id='ig_178414' ORDER BY time`, [tid])).rows;
  ok(msgs.length === 2 && msgs[0].type === 'image' && msgs[1].text === '📋 Presupuesto', 'IG: imagen y texto guardados en la conversación ig_178414');
  const media = await fetch(B + msgs[0].media_url, { headers: { Authorization: 'Bearer ' + tok } });
  ok(media.status === 200, 'IG: la imagen se ve en el chat (/api/media)');

  // 2) WhatsApp sigue igual, y un id de Instagram nunca sale por WhatsApp
  clearMeta();
  r = await j('/api/send-ticket', { method: 'POST', headers: H, body: JSON.stringify({ waId: '584140000000', ticketHtml, caption: 'Resguardo' }) });
  ok(r.status === 200 && r.body.success, 'WA: send-ticket responde OK');
  const wcalls = metaCalls();
  ok(wcalls.some(c => /graph\.facebook\.com\/v21\.0\/111\/messages/.test(c.url) && c.body.to === '584140000000'), 'WA: imagen enviada por WhatsApp');
  r = await j('/api/send-ticket', { method: 'POST', headers: H, body: JSON.stringify({ waId: 'ig_178414', ticketHtml }) });
  ok(r.status === 400, 'WA: waId "ig_…" rechazado (400)');
  r = await j('/api/send-ticket', { method: 'POST', headers: H, body: JSON.stringify({ igId: '../x', ticketHtml }) });
  ok(r.status === 400, 'IG: igId inválido rechazado (400)');

  await db.query('DELETE FROM tenants WHERE id=$1', [tid]);
  await db.end();
});
