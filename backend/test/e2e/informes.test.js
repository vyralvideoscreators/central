// Fallo 7: /api/reports en la zona horaria del negocio
// Se ejecuta con `npm test` (test/run.js arranca el servidor con Meta simulada y una base local vacía).
const { ok, j, send, reg, db: dbConnect, metaCalls, clearMeta, run, DEMO_KEY, adminToken } = require('../helpers/harness');
const B = process.env.BASE_URL;
const post = (H, u, b) => send(H, 'POST', u, b);
const TZ = 'America/Caracas';

run(async () => {
  const db = await dbConnect();
  const A = await reg('Informes A'), Bt = await reg('Informes B');
  await db.query('UPDATE tenants SET timezone=$1 WHERE id=$2', [TZ, A.id]);

  // Inserta un pedido con hora LOCAL del negocio (expresión SQL sobre "hoy local")
  let n = 0;
  async function order(tid, localExpr, o) {
    n++;
    const { rows } = await db.query(`
      INSERT INTO orders (tenant_id, client_name, platform, product_summary, total_price, delivery_status, pay_method_label,
                          delivery_method_label, address, shipping, tenant_order_number, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        ((${localExpr}) AT TIME ZONE '${TZ}') AT TIME ZONE current_setting('TimeZone'))
      RETURNING id`, [tid, o.client || 'C', o.platform || 'wa', o.summary || 'Resumen', o.total, o.status || 'to_deliver',
        o.pay || null, o.delivery || null, o.address || null, o.shipping || 0, n]);
    for (const it of (o.items || [])) {
      await db.query('INSERT INTO order_items (order_id, tenant_id, emoji, name, qty, unit_price, line_price) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [rows[0].id, tid, it.emoji, it.name, it.qty, it.price, it.qty * it.price]);
    }
  }
  const TODAY = `date_trunc('day', NOW() AT TIME ZONE '${TZ}')`;
  // Hoy (local): 3 pedidos
  await order(A.id, `${TODAY} + interval '5 minutes'`, { total: 50, platform: 'wa', status: 'delivered', pay: 'Zelle', delivery: 'Motorizado independiente', shipping: 3, items: [{ emoji: '👕', name: 'Franela', qty: 2, price: 20 }] });
  await order(A.id, `${TODAY} + interval '6 minutes'`, { total: 30, platform: 'ig', pay: 'Pago móvil', delivery: '📦 Encomienda MRW', address: 'Valencia', shipping: 5, items: [{ emoji: '🧢', name: 'Gorra', qty: 1, price: 25 }] });
  await order(A.id, `${TODAY} + interval '7 minutes'`, { total: 10, platform: 'wa', pay: 'Zelle', delivery: 'Retiro en tienda', summary: 'Pedido viejo sin artículos' });
  // Ayer a las 23:00 local (= hoy 03:00 UTC): NO es "hoy" para el negocio
  await order(A.id, `${TODAY} - interval '1 hour'`, { total: 1000, platform: 'wa' });
  // Hace 3 días y hace 40 días
  await order(A.id, `${TODAY} - interval '3 days' + interval '10 hours'`, { total: 7, platform: 'wa' });
  await order(A.id, `${TODAY} - interval '40 days'`, { total: 9, platform: 'wa' });
  // Otro negocio: nunca debe sumarse
  await order(Bt.id, `${TODAY} + interval '5 minutes'`, { total: 99999, platform: 'wa' });

  let r = await j('/api/reports?period=hoy', { headers: A.H });
  const h = r.body;
  ok(r.status === 200 && h.timezone === TZ, 'Usa la zona horaria guardada del negocio');
  ok(h.pedidos === 3 && h.ventas === 90, `Hoy local: 3 pedidos / $90 (la venta de ayer 23:00 no entra) → ${h.pedidos} / $${h.ventas}`);
  ok(h.entregados === 1 && h.pendientes === 2, 'Entregados / pendientes');
  ok(h.delivery === 1 && h.encomiendas === 1, 'Motorizado cuenta como delivery; "Encomienda MRW" como encomienda');
  ok(h.avgShipping === 4 && h.encomiendasIngresos === 5, 'Envío promedio $4 y $5 cobrados en encomiendas');
  ok(h.encomiendaRows.length === 1 && h.encomiendaRows[0].destino === 'Valencia' && h.encomiendaRows[0].estado === 'En tránsito' && /^#\d{4}$/.test(h.encomiendaRows[0].id), 'Registro de encomiendas');
  ok(JSON.stringify(h.paymentMethods) === JSON.stringify([['Zelle', 2], ['Pago móvil', 1]]), 'Métodos de pago agrupados y ordenados');
  ok(h.topProducts[0][0] === '👕 Franela' && h.topProducts[0][1] === 2 && h.topProducts.some(p => p[0] === '📦 Pedido viejo sin artículos'), 'Top productos (incluye pedidos sin artículos)');
  ok(h.canal.wa === 67 && h.canal.ig === 33, 'Canal 67% WA / 33% IG');
  ok(h.bars.length === 7 && h.barLabels.length === 7, 'Hoy: 7 barras por hora');

  r = await j('/api/reports?period=hoy&canal=ig', { headers: A.H });
  ok(r.body.pedidos === 1 && r.body.ventas === 30, 'Filtro de canal Instagram');

  r = await j('/api/reports?period=7dias', { headers: A.H });
  const sevenSum = r.body.bars.reduce((a, b) => a + b, 0);
  ok(r.body.pedidos === 5 && r.body.ventas === 1097 && Math.abs(sevenSum - 1097) < 0.01, `7 días: 5 pedidos, $1097 y las barras suman lo mismo → ${r.body.pedidos} / ${sevenSum}`);
  ok(r.body.barLabels.length === 7, '7 días: 7 barras por día');

  r = await j('/api/reports?period=año', { headers: A.H });
  ok(r.body.barLabels.length === 12 && Math.abs(r.body.bars.reduce((a, b) => a + b, 0) - r.body.ventas) < 0.01, 'Año: 12 barras que suman el total');

  // Personalizado y validaciones
  const today = (await db.query(`SELECT to_char(NOW() AT TIME ZONE '${TZ}','YYYY-MM-DD') d`)).rows[0].d;
  const minus = (k) => new Date(Date.parse(today) - k * 86400000).toISOString().slice(0, 10);
  r = await j(`/api/reports?period=personalizado&from=${minus(1)}&to=${minus(1)}`, { headers: A.H });
  ok(r.status === 200 && r.body.pedidos === 1 && r.body.ventas === 1000, 'Personalizado "ayer": exactamente el pedido de ayer 23:00');
  r = await j(`/api/reports?period=personalizado&from=${minus(45)}&to=${today}`, { headers: A.H });
  ok(r.body.pedidos === 6 && r.body.barLabels.length >= 2 && r.body.barLabels.length <= 3, 'Personalizado de 45 días: todo, barras por mes');
  for (const [d, q] of [['fechas inválidas', 'from=2026-13-40&to=2026-01-01'], ['from > to', `from=${today}&to=${minus(3)}`],
                        ['más de un año', `from=${minus(400)}&to=${today}`], ['inyección', "from=2026-01-01'--&to=2026-01-02"]]) {
    r = await j('/api/reports?period=personalizado&' + q, { headers: A.H });
    ok(r.status === 400, `Personalizado rechaza ${d} (400)`);
  }
  r = await j("/api/reports?period=hoy';DROP", { headers: A.H });
  ok(r.status === 400, 'period desconocido → 400');

  // Negocio sin zona guardada: usa la del navegador (tz) si es válida, si no la por defecto
  r = await j('/api/reports?period=hoy&tz=Asia/Tokyo', { headers: Bt.H });
  ok(r.body.timezone === 'Asia/Tokyo', 'Sin zona guardada: usa la del navegador');
  const Ct = await reg('Informes C');
  r = await j('/api/reports?period=hoy&tz=Nada/Inventada', { headers: Ct.H });
  await db.query('DELETE FROM tenants WHERE id=$1', [Ct.id]);
  ok(r.body.timezone === 'America/Caracas', 'Zona inválida: usa la por defecto');
  r = await j('/api/reports?period=año', { headers: Bt.H });
  ok(r.body.ventas === 99999 && r.body.pedidos === 1, 'Cada negocio ve solo lo suyo');

  for (const t of [A.id, Bt.id]) await db.query('DELETE FROM tenants WHERE id=$1', [t]);
  await db.end();
});
