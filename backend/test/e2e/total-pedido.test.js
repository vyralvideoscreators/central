// El total de un pedido con artículos lo calcula el servidor: Σ (precio x cantidad) + envío − descuento
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, send, reg, db: dbConnect, run } = require('../helpers/harness');

run(async () => {
  const db = await dbConnect();
  const A = await reg('Total A');
  const items = [{ name: 'Franela', qty: 2, unitPrice: 10.10, linePrice: 999 }, { name: 'Gorra', qty: 1, unitPrice: 5 }];

  // POST: el cliente manda totalPrice y linePrice falsos → se ignoran
  let r = await send(A.H, 'POST', '/api/orders', { clientName: 'Ana', totalPrice: 1, items, shipping: 3, discount: 2.5 });
  let o = r.body;
  ok(r.status === 200 && Number(o.totalPrice) === 25.7, `Total = 20.20 + 5 + 3 − 2.5 = 25.70 (${o.totalPrice})`);
  ok(Number(o.items[0].linePrice) === 20.2 && Number(o.discount) === 2.5 && Number(o.shipping) === 3, 'Subtotal recalculado en el servidor y descuento devuelto');
  ok((await send(A.H, 'POST', '/api/orders', { clientName: 'Sin desc', items })).body.discount == 0, 'Sin descuento → discount 0');

  // PATCH total_price en pedido con artículos: se ignora (sin error)
  r = await send(A.H, 'PATCH', '/api/orders/' + o.id, { total_price: 10 });
  ok(r.status === 200 && Number(r.body.totalPrice) === 25.7, 'PATCH total_price=10 en pedido con artículos → el total sigue cuadrando');
  r = await send(A.H, 'PATCH', '/api/orders/' + o.id, { total_price: 10, notes: 'x' });
  ok(r.status === 200 && Number(r.body.totalPrice) === 25.7 && r.body.notes === 'x', 'Total ignorado junto a otros campos');

  // PATCH discount / shipping recalculan con los valores guardados
  r = await send(A.H, 'PATCH', '/api/orders/' + o.id, { discount: 5 });
  ok(r.status === 200 && Number(r.body.totalPrice) === 23.2, `PATCH discount=5 → 20.20+5+3−5 = 23.20 (${r.body.totalPrice})`);
  r = await send(A.H, 'PATCH', '/api/orders/' + o.id, { shipping: 0 });
  ok(Number(r.body.totalPrice) === 20.2, `PATCH shipping=0 → 25.20−5 = 20.20 (${r.body.totalPrice})`);
  r = await send(A.H, 'PATCH', '/api/orders/' + o.id, { items: [{ name: 'Solo', qty: 3, unitPrice: 4, linePrice: 1 }] });
  ok(Number(r.body.totalPrice) === 7 && Number(r.body.items[0].linePrice) === 12, 'PATCH items recalcula: 12 + 0 − 5 = 7');

  // Descuento excesivo → 400 y nada cambia
  r = await send(A.H, 'PATCH', '/api/orders/' + o.id, { discount: 12.01 });
  ok(r.status === 400 && r.body.error === 'El descuento no puede ser mayor que el total', 'Descuento mayor que el total → 400');
  r = await send(A.H, 'PATCH', '/api/orders/' + o.id, { shipping: 0, items: [{ name: 'Barato', qty: 1, unitPrice: 1 }] });
  ok(r.status === 400, 'Cambiar artículos dejando un descuento (5) mayor que el nuevo total → 400');
  r = await send(A.H, 'POST', '/api/orders', { clientName: 'X', items, discount: 1000 });
  ok(r.status === 400 && r.body.error === 'El descuento no puede ser mayor que el total', 'POST con descuento excesivo → 400');
  r = await send(A.H, 'POST', '/api/orders', { clientName: 'X', items, discount: -1 });
  ok(r.status === 400 && r.body.error === 'Descuento inválido', 'Descuento negativo → 400');
  r = await send(A.H, 'POST', '/api/orders', { clientName: 'X', items: [{ name: 'Caro', qty: 100000, unitPrice: 5e7 }] });
  ok(r.status === 400, 'Total fuera de rango → 400 (no 500)');
  ok(Number((await send(A.H, 'PATCH', '/api/orders/' + o.id, { notes: 'y' })).body.totalPrice) === 7, 'Tras los rechazos el total sigue siendo 7');

  // Pedido antiguo sin artículos: conserva y acepta el total enviado
  const legacy = (await send(A.H, 'POST', '/api/orders', { clientName: 'Viejo', totalPrice: 33.333, productSummary: 'Resumen' })).body;
  ok(Number(legacy.totalPrice) === 33.33, 'Sin artículos: se respeta el total enviado');
  r = await send(A.H, 'PATCH', '/api/orders/' + legacy.id, { total_price: 40 });
  ok(Number(r.body.totalPrice) === 40, 'Sin artículos: PATCH total_price se acepta');
  r = await send(A.H, 'PATCH', '/api/orders/' + legacy.id, { shipping: 4 });
  ok(Number(r.body.totalPrice) === 40 && Number(r.body.shipping) === 4, 'Sin artículos: cambiar envío no toca el total');

  // Pedido con artículos puesto a mano en la base con total libre: no cambia hasta que se edite artículos/envío/descuento
  const { rows } = await db.query(`SELECT total_price FROM orders WHERE id=$1`, [o.id]);
  ok(Number(rows[0].total_price) === 7, 'En la base el total queda guardado');

  await db.query('DELETE FROM tenants WHERE id=$1', [A.id]);
  await db.end();
});
