// Fallo 4: pedidos ↔ fichas de cliente
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, metaCalls, clearMeta, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const B = process.env.BASE_URL;
const post = (H, u, b) => send(H, 'POST', u, b);

run(async () => {
  const db = await dbConnect();

  const A = await reg('Tienda A'), Bt = await reg('Tienda B');
  const item = { emoji: '👕', name: 'Franela', qty: 1, unitPrice: 10, linePrice: 10 };

  // Pedido desde un chat sin ficha → crea la ficha vinculada al chat
  let r = await post(A.H, '/api/orders', { clientName: 'Marta Ruiz', clientConvoKey: '584141112233', clientPhone: '+584141112233', platform: 'wa', totalPrice: 10, items: [item] });
  ok(r.status === 200 && r.body.clientId && r.body.createdClient && r.body.createdClient.convoKey === '584141112233', 'Chat sin ficha: crea la ficha con su chat y teléfono');
  const martaId = r.body.clientId;
  r = await post(A.H, '/api/orders', { clientName: 'Marta Ruiz', clientConvoKey: '584141112233', platform: 'wa', totalPrice: 5, items: [item] });
  ok(r.body.clientId === martaId && !r.body.createdClient, 'Mismo chat y nombre: reutiliza la ficha (sin duplicar)');
  r = await post(A.H, '/api/orders', { clientName: 'Amiga de Marta', clientConvoKey: '584141112233', platform: 'wa', totalPrice: 5, items: [item] });
  ok(r.body.clientId && r.body.clientId !== martaId && r.body.createdClient.convoKey === null, 'Mismo chat, otro nombre: ficha nueva sin robar el chat');

  // Dos clientes con el mismo nombre: cada pedido va a su ficha
  const c1 = (await post(A.H, '/api/clients', { name: 'José Pérez', phone: '1' })).body;
  const c2 = (await post(A.H, '/api/clients', { name: 'José Pérez', phone: '2' })).body;
  r = await post(A.H, '/api/orders', { clientName: 'José Pérez', clientId: c2.id, totalPrice: 1, items: [item] });
  ok(r.body.clientId === c2.id, 'Mismo nombre: el pedido va a la ficha elegida (la segunda)');

  // Renombrar la ficha actualiza el nombre en sus pedidos
  await j('/api/clients/' + c2.id, { method: 'PATCH', headers: A.H, body: JSON.stringify({ name: 'José Pérez Gil', phone: '2' }) });
  const ords = (await j('/api/orders', { headers: A.H })).body;
  ok(ords.find(o => o.clientId === c2.id).clientName === 'José Pérez Gil', 'Renombrar ficha: sus pedidos muestran el nombre nuevo');
  ok(!ords.some(o => o.clientId === c1.id), 'La otra ficha "José Pérez" no recibe pedidos ajenos');

  // Aislamiento: no se puede usar la ficha de otro negocio
  r = await post(Bt.H, '/api/orders', { clientName: 'X', clientId: c1.id, totalPrice: 1, items: [item] });
  ok(r.status === 400, 'Ficha de otro negocio → 400');
  r = await post(Bt.H, '/api/orders', { clientName: 'X', clientId: 'no-es-un-uuid', totalPrice: 1, items: [item] });
  ok(r.status === 400, 'clientId inválido → 400');
  const bOrders = (await j('/api/orders', { headers: Bt.H })).body;
  ok(bOrders.length === 0, 'Tras el 400 no queda pedido a medias en la tienda B');
  r = await post(Bt.H, '/api/orders', { clientName: 'Y', clientConvoKey: "x'; DROP TABLE clients;--", totalPrice: 1, items: [item] });
  ok(r.status === 200 && r.body.createdClient.convoKey === null, 'convoKey con basura se ignora');

  for (const t of [A.id, Bt.id]) await db.query('DELETE FROM tenants WHERE id=$1', [t]);
  await db.end();
});
