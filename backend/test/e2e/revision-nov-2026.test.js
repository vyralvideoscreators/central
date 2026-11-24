// Correcciones de la revisión
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, metaCalls, clearMeta, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const B = process.env.BASE_URL;
const post = (H, u, b) => send(H, 'POST', u, b);
const item = { name: 'X', qty: 1, unitPrice: 1 };

run(async () => {
  const db = await dbConnect();
  const A = await reg('Rev A');

  // Ficha antigua (sin chat): el primer pedido desde su chat la reutiliza y le asigna el chat
  const ana = (await send(A.H, 'POST', '/api/clients', { name: 'Ana Vieja' })).body;
  let r = await send(A.H, 'POST', '/api/orders', { clientName: 'Ana Vieja', clientConvoKey: 'ig_555', items: [item] });
  ok(r.body.clientId === ana.id && !r.body.createdClient, 'Ficha antigua con el mismo nombre se reutiliza (no se duplica)');
  let ck = (await db.query('SELECT convo_key FROM clients WHERE id=$1', [ana.id])).rows[0].convo_key;
  ok(ck === 'ig_555', 'Y queda vinculada a su chat');
  r = await send(A.H, 'POST', '/api/orders', { clientName: 'Ana Vieja', clientConvoKey: 'ig_555', items: [item] });
  ok(r.body.clientId === ana.id, 'El siguiente pedido la encuentra por el chat');
  // Dos fichas antiguas con el mismo nombre: ambigua → ficha nueva (no se adivina)
  await send(A.H, 'POST', '/api/clients', { name: 'Luis Par' }); await send(A.H, 'POST', '/api/clients', { name: 'Luis Par' });
  r = await send(A.H, 'POST', '/api/orders', { clientName: 'Luis Par', clientConvoKey: '58400111', items: [item] });
  ok(!!r.body.createdClient, 'Nombre ambiguo: no adivina, crea ficha nueva vinculada al chat');

  // Ficha elegida por la app como "la del chat" (clientId + clientConvoKey): se le asigna el chat
  const pepe = (await send(A.H, 'POST', '/api/clients', { name: 'Pepe' })).body;
  r = await send(A.H, 'POST', '/api/orders', { clientName: 'Pepe', clientId: pepe.id, clientConvoKey: '58499999', items: [item] });
  ck = (await db.query('SELECT convo_key FROM clients WHERE id=$1', [pepe.id])).rows[0].convo_key;
  ok(r.status === 200 && ck === '58499999', 'clientId + chat: la ficha queda vinculada al chat');
  // El chat ya es de otra ficha: el pedido se guarda igual y no roba el chat
  const otra = (await send(A.H, 'POST', '/api/clients', { name: 'Otra' })).body;
  r = await send(A.H, 'POST', '/api/orders', { clientName: 'Otra', clientId: otra.id, clientConvoKey: '58499999', items: [item] });
  ck = (await db.query('SELECT convo_key FROM clients WHERE id=$1', [otra.id])).rows[0].convo_key;
  ok(r.status === 200 && ck === null, 'Chat ya ocupado: el pedido se guarda y no se roba el chat');

  // Carrera: 6 pedidos simultáneos del mismo chat nuevo → 0 errores, 1 sola ficha
  const res = await Promise.all(Array.from({ length: 6 }, () =>
    send(A.H, 'POST', '/api/orders', { clientName: 'Rápida', clientConvoKey: '58477777', items: [item] })));
  ok(res.every(x => x.status === 200), 'Pedidos simultáneos del mismo chat: ninguno falla (' + res.map(x => x.status).join(',') + ')');
  const n = (await db.query(`SELECT COUNT(*)::int n FROM clients WHERE tenant_id=$1 AND name='Rápida'`, [A.id])).rows[0].n;
  ok(n === 1, `Pedidos simultáneos: una sola ficha (${n})`);
  // Carrera en alta directa de fichas con el mismo chat
  const res2 = await Promise.all(Array.from({ length: 4 }, (_, i) => send(A.H, 'POST', '/api/clients', { name: 'Dup' + i, convoKey: '58466666' })));
  ok(res2.every(x => x.status === 200), 'Altas simultáneas con el mismo chat: ninguna falla');

  // Validación al editar
  const o = (await send(A.H, 'POST', '/api/orders', { clientName: 'V', items: [item] })).body;
  for (const [d, b] of [['total texto', { total_price: 'abc' }], ['envío negativo', { shipping: -1 }], ['pay_status raro', { pay_status: 'pagado' }], ['delivery_status raro', { delivery_status: 'x' }]]) {
    r = await send(A.H, 'PATCH', '/api/orders/' + o.id, b);
    ok(r.status === 400, `Editar: rechaza ${d} (400)`);
  }
  r = await send(A.H, 'PATCH', '/api/orders/' + o.id, { total_price: '12.345', delivery_status: 'delivered' });
  ok(r.status === 200 && Number(r.body.totalPrice) === 12.35 && r.body.deliveryStatus === 'delivered', 'Editar: total numérico redondeado y estado válido');
  r = await send(A.H, 'PATCH', '/api/clients/no-uuid', { name: 'x' });
  ok(r.status === 404, 'Cliente con id inválido → 404 (no 500)');
  r = await j('/api/clients/no-uuid', { method: 'DELETE', headers: A.H });
  ok(r.status === 404, 'Borrar cliente con id inválido → 404');

  // Informes
  r = await j('/api/reports?period=personalizado&from=2026-02-31&to=2026-03-02', { headers: A.H });
  ok(r.status === 400, '31 de febrero → 400 (no 500)');
  await db.query(`UPDATE clients SET channel='ig' WHERE tenant_id=$1 AND name='Ana Vieja'`, [A.id]);
  const all = (await j('/api/reports?period=hoy', { headers: A.H })).body.newClients;
  const ig = (await j('/api/reports?period=hoy&canal=ig', { headers: A.H })).body.newClients;
  ok(ig >= 1 && ig < all, `Clientes nuevos respetan el filtro de canal (todos ${all}, IG ${ig})`);
  const tzb = await reg('Rev TZ');
  r = await j('/api/reports?period=hoy&tz=Asia/Tokyo', { headers: tzb.H });
  const saved = (await db.query('SELECT timezone FROM tenants WHERE id=$1', [tzb.id])).rows[0].timezone;
  ok(r.body.timezone === 'Asia/Tokyo' && saved === 'Asia/Tokyo', 'Sin zona: guarda la del navegador como la del negocio');
  r = await j('/api/reports?period=hoy&tz=Europe/Madrid', { headers: tzb.H });
  ok(r.body.timezone === 'Asia/Tokyo', 'Después usa siempre la guardada (no la del equipo que abre)');

  for (const t of [A.id, tzb.id]) await db.query('DELETE FROM tenants WHERE id=$1', [t]);
  await db.end();
});
