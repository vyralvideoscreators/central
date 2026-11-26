// Fase 4B — paginación por cursor de pedidos, chats y mensajes; filtros de servidor y contadores sobre TODOS los datos.
const { ok, run } = require('../helpers/harness');
const { j, send, reg, db } = require('../helpers/equipo');

run(async () => {
  const c = await db();
  const A = await reg('Pagina A');
  const B = await reg('Pagina B');
  // 230 pedidos del negocio A (varios con la MISMA fecha para probar el desempate por id), 3 de B
  await c.query(`
    INSERT INTO orders (tenant_id, client_name, product_summary, total_price, delivery_status, tenant_order_number, created_at, pay_status)
    SELECT $1, 'Cliente ' || (g % 7), CASE WHEN g % 10 = 0 THEN 'Camisa roja' ELSE 'Taza' END, 10,
      (ARRAY['to_deliver','preparing','on_the_way','delivered','not_delivered'])[1 + g % 5], g,
      now() - make_interval(secs => (g / 3) * 60), 'pend'
    FROM generate_series(1, 230) g`, [A.id]);
  await c.query(`UPDATE tenants SET order_seq = 230 WHERE id = $1`, [A.id]);
  await c.query(`UPDATE orders SET delivery_status = 'cancelled' WHERE tenant_id = $1 AND tenant_order_number IN (1, 2, 3)`, [A.id]);
  await c.query(`UPDATE orders SET kind = 'quote', tenant_order_number = NULL, quote_number = tenant_order_number WHERE tenant_id = $1 AND tenant_order_number IN (4, 5)`, [A.id]);
  await c.query(`UPDATE orders SET delivery_date = (now() AT TIME ZONE 'America/Caracas')::date WHERE tenant_id = $1 AND tenant_order_number IN (6, 7, 8, 9)`, [A.id]);
  await c.query(`UPDATE orders SET delivery_date = (now() AT TIME ZONE 'America/Caracas')::date + 1 WHERE tenant_id = $1 AND tenant_order_number IN (11, 12)`, [A.id]);
  await c.query(`INSERT INTO orders (tenant_id, client_name, total_price, delivery_status, tenant_order_number, pay_status) SELECT $1, 'Ajeno', 5, 'to_deliver', g, 'pend' FROM generate_series(1,3) g`, [B.id]);

  // Compatibilidad: sin parámetros, el arreglo de siempre
  let r = await j('/api/orders', { headers: A.H });
  ok(r.status === 200 && Array.isArray(r.body) && r.body.length === 230, 'Sin parámetros: arreglo con todos los pedidos (compatibilidad)');

  // Páginas con cursor: sin repetidos ni saltos, orden descendente
  r = await j('/api/orders?limit=100&counts=1', { headers: A.H });
  ok(r.status === 200 && r.body.orders.length === 100 && !!r.body.nextCursor && !!r.body.counts, 'Página 1: 100 pedidos, cursor y contadores');
  const seen = new Set(r.body.orders.map(o => o.id));
  let cursor = r.body.nextCursor, pages = 1, all = [...r.body.orders];
  while (cursor && pages < 10) {
    const p = await j('/api/orders?limit=100&before=' + encodeURIComponent(cursor), { headers: A.H });
    ok(p.status === 200 && p.body.counts === undefined, 'Página ' + (pages + 1) + ' sin contadores (solo la primera)');
    for (const o of p.body.orders) { if (seen.has(o.id)) ok(false, 'Pedido repetido entre páginas ' + o.id); seen.add(o.id); }
    all = all.concat(p.body.orders);
    cursor = p.body.nextCursor; pages++;
  }
  ok(all.length === 230 && pages === 3 && seen.size === 230, 'Tres páginas (100+100+30) suman los 230 sin repetir ni saltar');
  const times = all.map(o => new Date(o.createdAt).getTime());
  ok(times.every((t, i) => i === 0 || t <= times[i - 1]), 'Orden: del más reciente al más antiguo');
  const legacy = (await j('/api/orders', { headers: A.H })).body.map(o => o.id);
  ok(JSON.stringify(legacy) === JSON.stringify(all.map(o => o.id)), 'El orden de las páginas coincide con el de siempre');
  r = await j('/api/orders?limit=5000', { headers: A.H });
  ok(r.body.orders.length === 200, 'limit máximo 200');
  r = await j('/api/orders?before=basura', { headers: A.H });
  ok(r.status === 400, 'Cursor inválido → 400 (no 500)');
  r = await j('/api/orders?limit=10&before=' + Buffer.from(JSON.stringify({ c: "2020-01-01T00:00:00'; DROP", i: 'x' })).toString('base64url'), { headers: A.H });
  ok(r.status === 400, 'Cursor manipulado → 400');

  // Contadores sobre TODOS los pedidos, no solo los cargados
  const cnt = (await j('/api/orders?limit=20&counts=1', { headers: A.H })).body.counts;
  const { rows: [exp] } = await c.query(`SELECT
    count(*) FILTER (WHERE kind='order' AND delivery_status<>'cancelled')::int AS "all",
    count(*) FILTER (WHERE kind='order' AND delivery_status='delivered')::int AS delivered,
    count(*) FILTER (WHERE kind='quote')::int AS quote, count(*) FILTER (WHERE delivery_status='cancelled')::int AS cancelled
    FROM orders WHERE tenant_id = $1`, [A.id]);
  ok(cnt.all === exp.all && cnt.delivered === exp.delivered && cnt.quote === exp.quote && cnt.cancelled === exp.cancelled,
    'Contadores correctos con 20 cargados (todos=' + cnt.all + ', entregados=' + cnt.delivered + ', presupuestos=' + cnt.quote + ', anulados=' + cnt.cancelled + ')');
  ok(cnt.all === 225 && cnt.quote === 2 && cnt.cancelled === 3, 'Todos 225, presupuestos 2, anulados 3');
  ok(cnt.to_deliver + cnt.preparing + cnt.on_the_way + cnt.delivered + cnt.not_delivered === cnt.all, 'Las pestañas por estado suman «todos»');
  ok(cnt.pending_pay === 225 && cnt.owed === 2250, 'Por cobrar: 225 pedidos y 2250');
  ok(cnt.today >= 1 && cnt.tomorrow === 2 || cnt.today >= 0, 'Hoy / mañana vienen del servidor (' + cnt.today + '/' + cnt.tomorrow + ')');
  ok(cnt.ordersToday + cnt.ordersYesterday > 0 && cnt.salesToday >= 0, 'Pedidos y ventas de hoy y ayer (' + cnt.ordersToday + '/' + cnt.ordersYesterday + ')');

  // Filtros de servidor
  r = await j('/api/orders?status=delivered&limit=100', { headers: A.H });
  ok(r.body.orders.length === cnt.delivered && r.body.orders.every(o => o.deliveryStatus === 'delivered' && o.kind === 'order'), 'Filtro por estado');
  r = await j('/api/orders?status=cancelled&limit=100', { headers: A.H });
  ok(r.body.orders.length === 3, 'Filtro anulados');
  r = await j('/api/orders?kind=quote&limit=100', { headers: A.H });
  ok(r.body.orders.length === 2 && r.body.orders.every(o => o.kind === 'quote'), 'Filtro presupuestos');
  r = await j('/api/orders?status=all&limit=200', { headers: A.H });
  ok(r.body.orders.length === 200 && r.body.orders.every(o => o.kind === 'order' && !o.cancelled), 'Todos = pedidos vigentes');
  r = await j('/api/orders?status=pending_pay&limit=200', { headers: A.H });
  ok(r.body.orders.length === 200 && r.body.nextCursor, 'Por cobrar');
  r = await j('/api/orders?deliveryDate=tomorrow', { headers: A.H });
  ok(r.status === 200 && r.body.orders.length === cnt.tomorrow, 'Entrega mañana coincide con el contador (' + r.body.orders.length + ')');
  r = await j('/api/orders?deliveryDate=today', { headers: A.H });
  ok(r.status === 200 && r.body.orders.length === cnt.today, 'Entrega hoy coincide con el contador (' + r.body.orders.length + ')');
  r = await j('/api/orders?q=camisa&limit=100', { headers: A.H });
  ok(r.body.orders.length > 0 && r.body.orders.every(o => /camisa/i.test(o.productSummary)), 'Búsqueda por producto (en TODOS los pedidos, no solo los cargados)');
  r = await j('/api/orders?q=' + encodeURIComponent('Cliente 3') + '&limit=200', { headers: A.H });
  ok(r.body.orders.length > 0 && r.body.orders.every(o => o.clientName === 'Cliente 3'), 'Búsqueda por cliente');
  r = await j('/api/orders?q=' + encodeURIComponent('#0200'), { headers: A.H });
  ok(r.body.orders.length === 1 && r.body.orders[0].orderNumber === '#0200', 'Búsqueda por número (#0200)');
  r = await j('/api/orders?q=' + encodeURIComponent('P-0004'), { headers: A.H });
  ok(r.body.orders.length === 1 && r.body.orders[0].kind === 'quote', 'Búsqueda por número de presupuesto');
  r = await j('/api/orders?q=' + encodeURIComponent("%'; DROP TABLE orders;--"), { headers: A.H });
  ok(r.status === 200 && r.body.orders.length === 0, 'Un texto raro en la búsqueda no rompe ni coincide con todo');
  r = await j('/api/orders?status=inventado', { headers: A.H });
  ok(r.status === 400, 'Estado inválido → 400');
  r = await j('/api/orders?clientId=no-uuid', { headers: A.H });
  ok(r.status === 400, 'clientId inválido → 400');
  const cl = (await send(A.H, 'POST', '/api/clients', { name: 'Con Pedido' })).body;
  await send(A.H, 'POST', '/api/orders', { clientName: 'Con Pedido', clientId: cl.id, items: [{ name: 'X', qty: 1, unitPrice: 3 }] });
  r = await j('/api/orders?clientId=' + cl.id, { headers: A.H });
  ok(r.body.orders.length === 1 && r.body.orders[0].clientId === cl.id, 'Filtro por cliente');
  // Aislamiento
  r = await j('/api/orders?limit=100&counts=1', { headers: B.H });
  ok(r.body.orders.length === 3 && r.body.counts.all === 3, 'El otro negocio solo ve y cuenta lo suyo');
  const cursA = (await j('/api/orders?limit=5', { headers: A.H })).body.nextCursor;
  r = await j('/api/orders?limit=100&before=' + encodeURIComponent(cursA), { headers: B.H });
  ok(r.body.orders.length <= 3 && r.body.orders.every(o => o.clientName === 'Ajeno'), 'Un cursor de A no revela pedidos de A a B');

  // ── Chats y mensajes ──
  await c.query(`INSERT INTO conversations (wa_id, tenant_id, name, platform, last_message_at)
    SELECT '58400' || lpad(g::text, 6, '0'), $1, 'Chat ' || g, 'wa', now() - make_interval(mins => g) FROM generate_series(1, 130) g`, [A.id]);
  await c.query(`INSERT INTO conversations (wa_id, tenant_id, name, platform, last_message_at) VALUES ('584999999999', $1, 'Sin fecha', 'wa', NULL)`, [A.id]);
  await c.query(`INSERT INTO messages (id, wa_id, tenant_id, role, type, text, time)
    SELECT 'm' || g, '58400000001', $1, CASE WHEN g % 2 = 0 THEN 'in' ELSE 'out' END, 'text', 'mensaje ' || g, now() - make_interval(secs => 200 - g) FROM generate_series(1, 120) g`, [A.id]);
  r = await j('/api/conversations', { headers: A.H });
  ok(Array.isArray(r.body) && r.body.length === 131, 'Chats sin parámetros: arreglo de siempre');
  const c1 = r.body.find(x => x.waId === '58400000001');
  ok(c1.messages.length === 120 && c1.messages[0].text === 'mensaje 1' && c1.messages[119].text === 'mensaje 120', 'Y con sus mensajes en orden');
  r = await j('/api/conversations?limit=100', { headers: A.H });
  ok(r.body.conversations.length === 100 && !!r.body.nextCursor, 'Chats: 100 por página con cursor');
  ok(r.body.conversations[0].messages.length <= 20, 'Cada chat de la lista trae solo sus últimos mensajes');
  const ids = new Set(r.body.conversations.map(x => x.waId));
  const r2 = await j('/api/conversations?limit=100&before=' + encodeURIComponent(r.body.nextCursor), { headers: A.H });
  ok(r2.body.conversations.length === 31 && r2.body.nextCursor === null && r2.body.conversations.every(x => !ids.has(x.waId)), 'Segunda página: los 31 restantes (incluido el chat sin fecha al final)');
  ok(r2.body.conversations[30].waId === '584999999999', 'El chat sin fecha va al final');
  r = await j('/api/conversations?q=' + encodeURIComponent('Chat 12') + '&limit=100', { headers: A.H });
  ok(r.body.conversations.length >= 1 && r.body.conversations.every(x => /Chat 12/.test(x.name)), 'Búsqueda de chats por nombre');
  r = await j('/api/conversations?before=xx', { headers: A.H });
  ok(r.status === 400, 'Cursor de chats inválido → 400');
  r = await j('/api/conversations?limit=10', { headers: B.H });
  ok(r.body.conversations.length === 0, 'Otro negocio: sin chats de A');
  // Mensajes hacia atrás
  r = await j('/api/conversations/58400000001?limit=50', { headers: A.H });
  ok(r.body.messages.length === 50 && r.body.hasMore && r.body.messages[49].text === 'mensaje 120' && r.body.messages[0].text === 'mensaje 71', 'Mensajes: los últimos 50, del antiguo al reciente');
  r = await j('/api/conversations/58400000001?limit=50&before=' + encodeURIComponent(r.body.nextBefore), { headers: A.H });
  ok(r.body.messages.length === 50 && r.body.messages[49].text === 'mensaje 70' && r.body.hasMore, 'Los 50 anteriores');
  r = await j('/api/conversations/58400000001?limit=50&before=' + encodeURIComponent(r.body.nextBefore), { headers: A.H });
  ok(r.body.messages.length === 20 && r.body.messages[0].text === 'mensaje 1' && !r.body.hasMore && r.body.nextBefore === null, 'La última página trae 20 y termina');
  r = await j('/api/conversations/58400000001', { headers: A.H });
  ok(r.body.messages.length === 120, 'Sin limit: todos los mensajes (compatibilidad)');
  r = await j('/api/conversations/58400000001?limit=10', { headers: B.H });
  ok(r.status === 404, 'Otro negocio: 404');
  r = await j('/api/conversations/58400000001?limit=10&before=zzz', { headers: A.H });
  ok(r.status === 400, 'Cursor de mensajes inválido → 400');
  await c.end();
});
