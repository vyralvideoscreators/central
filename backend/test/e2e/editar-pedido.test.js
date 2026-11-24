// Fallo 5: editar pedidos (datos + artículos)
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, metaCalls, clearMeta, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const B = process.env.BASE_URL;
const post = (H, u, b) => send(H, 'POST', u, b);

run(async () => {
  const db = await dbConnect();
  const A = await reg('Edit A'), Bt = await reg('Edit B');
  const prodA = (await send(A.H, 'POST', '/api/catalog', { name: 'Gorra', price: 12 })).body;
  const prodB = (await send(Bt.H, 'POST', '/api/catalog', { name: 'Ajeno', price: 1 })).body;
  const cli = (await send(A.H, 'POST', '/api/clients', { name: 'Rosa' })).body;
  const order = (await send(A.H, 'POST', '/api/orders', { clientName: 'Pedro', totalPrice: 20, items: [{ name: 'Franela', qty: 2, unitPrice: 10, linePrice: 20 }] })).body;
  ok(order.items.length === 1, 'Pedido creado con 1 artículo');

  // Editar todo a la vez
  let r = await send(A.H, 'PATCH', '/api/orders/' + order.id, {
    client_id: cli.id, client_name: 'Rosa',
    items: [{ name: 'Franela', qty: 3, unitPrice: 10, linePrice: 30 }, { name: 'Gorra', qty: 1, unitPrice: 12, productId: prodA.id, emoji: '🧢' }],
    product_summary: '3x Franela + Gorra', total_price: 45, shipping: 3,
    pay_method_label: 'Zelle', delivery_method_label: 'Motorizado', address: 'Calle 2', notes: 'Tocar timbre',
  });
  const o = r.body;
  ok(r.status === 200, 'PATCH completo → 200');
  ok(o.items.length === 2 && o.items[0].qty === 3 && o.items[1].productId === prodA.id && Number(o.items[1].linePrice) === 12, 'Artículos reemplazados (cantidad, producto del catálogo, subtotal calculado)');
  ok(o.clientId === cli.id && o.clientName === 'Rosa', 'Pedido pasado a la ficha de Rosa');
  ok(Number(o.totalPrice) === 45 && Number(o.shipping) === 3 && o.payMethodLabel === 'Zelle' && o.address === 'Calle 2' && o.notes === 'Tocar timbre', 'Total, envío, pago, dirección y notas guardados');
  ok(o.orderNumber === order.orderNumber, 'El número del pedido no cambia');
  const n = (await db.query('SELECT COUNT(*)::int n FROM order_items WHERE order_id=$1', [order.id])).rows[0].n;
  ok(n === 2, 'En la base quedan exactamente 2 artículos (los viejos se borraron)');

  // Producto de otro negocio: se guarda el artículo pero sin enlazar el producto ajeno
  r = await send(A.H, 'PATCH', '/api/orders/' + order.id, { items: [{ name: 'X', qty: 1, unitPrice: 1, productId: prodB.id }] });
  ok(r.status === 200 && r.body.items[0].productId === null, 'Producto de otro negocio → no se enlaza');

  // Validaciones: nada se modifica si algo falla
  const before = (await j('/api/orders', { headers: A.H })).body[0];
  for (const [desc, body] of [
    ['cantidad 0', { items: [{ name: 'X', qty: 0, unitPrice: 1 }] }],
    ['cantidad decimal', { items: [{ name: 'X', qty: 1.5, unitPrice: 1 }] }],
    ['precio negativo', { items: [{ name: 'X', qty: 1, unitPrice: -5 }] }],
    ['artículo sin nombre', { items: [{ name: '', qty: 1, unitPrice: 1 }] }],
    ['items no es lista', { items: 'hola' }],
    ['101 artículos', { items: Array.from({ length: 101 }, () => ({ name: 'X', qty: 1, unitPrice: 1 })) }],
    ['ficha de otro negocio', { client_id: (await send(Bt.H, 'POST', '/api/clients', { name: 'Z' })).body.id, notes: 'no' }],
    ['sin campos válidos', { foo: 1 }],
  ]) {
    r = await send(A.H, 'PATCH', '/api/orders/' + order.id, body);
    ok(r.status === 400, `Rechaza ${desc} (400)`);
  }
  const after = (await j('/api/orders', { headers: A.H })).body[0];
  ok(JSON.stringify(after) === JSON.stringify(before), 'Tras los rechazos el pedido sigue idéntico');

  // Quitar la ficha
  r = await send(A.H, 'PATCH', '/api/orders/' + order.id, { client_id: null, client_name: 'Anónimo' });
  ok(r.status === 200 && r.body.clientId === null && r.body.clientName === 'Anónimo', 'client_id null → pedido sin ficha');

  // Aislamiento: otro negocio no puede editarlo; id inválido → 404
  r = await send(Bt.H, 'PATCH', '/api/orders/' + order.id, { notes: 'hack' });
  ok(r.status === 404, 'Otro negocio no puede editar el pedido (404)');
  r = await send(A.H, 'PATCH', '/api/orders/no-uuid', { notes: 'x' });
  ok(r.status === 404, 'Id inválido → 404 (no 500)');

  // Lo que ya funcionaba: cambio de estado simple
  r = await send(A.H, 'PATCH', '/api/orders/' + order.id, { delivery_status: 'delivered' });
  ok(r.status === 200 && r.body.deliveryStatus === 'delivered' && r.body.items.length === 1, 'Cambiar solo la entrega sigue igual y no toca artículos');

  // POST valida los artículos igual
  r = await send(A.H, 'POST', '/api/orders', { clientName: 'X', items: [{ name: 'X', qty: -1 }] });
  ok(r.status === 400, 'POST con cantidad inválida → 400');

  for (const t of [A.id, Bt.id]) await db.query('DELETE FROM tenants WHERE id=$1', [t]);
  await db.end();
});
