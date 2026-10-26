// Datos 100 % inventados para las cuentas demo (ropa y calzado).
// Nada de aquí puede coincidir con datos reales ni con los datos de prueba
// originales de la app: test/demo-data.test.js lo comprueba.
// Teléfonos con el bloque 555-2xxx, reservado para ficción.

const C = {
  coral:   { name: 'Coral',          hex: '#f0806a' },
  marfil:  { name: 'Marfil',         hex: '#f3ead8' },
  arena:   { name: 'Arena',          hex: '#d6c3a1' },
  oliva:   { name: 'Oliva',          hex: '#6b7a3a' },
  indigo:  { name: 'Índigo',         hex: '#2f3e6e' },
  humo:    { name: 'Gris humo',      hex: '#8a8f98' },
  hueso:   { name: 'Blanco hueso',   hex: '#efe9df' },
  menta:   { name: 'Verde menta',    hex: '#9fd8c0' },
  camel:   { name: 'Camel',          hex: '#b07a45' },
  azabache:{ name: 'Negro azabache', hex: '#151515' },
};

const PRODUCTS = [
  { key: 'p1', cat: ['prendas', 'Prendas', '👚'], name: 'Blusa Bordada Amapola',  emoji: '👚', price: 34, sizes: ['XS', 'S', 'M', 'L'],            colors: [C.coral, C.marfil] },
  { key: 'p2', cat: ['prendas', 'Prendas', '👚'], name: 'Pantalón Palazzo Brisa', emoji: '👖', price: 42, sizes: ['S', 'M', 'L', 'XL'],            colors: [C.arena, C.oliva] },
  { key: 'p3', cat: ['prendas', 'Prendas', '👚'], name: 'Chaqueta Denim Cropped', emoji: '🧥', price: 56, sizes: ['S', 'M', 'L'],                  colors: [C.indigo, C.humo] },
  { key: 'p4', cat: ['zapatos', 'Zapatos', '👟'], name: 'Tenis Urbano Nube',      emoji: '👟', price: 64, sizes: ['36', '37', '38', '39', '40', '41'], colors: [C.hueso, C.menta] },
  { key: 'p5', cat: ['zapatos', 'Zapatos', '👟'], name: 'Botín Chelsea Siena',    emoji: '👢', price: 79, sizes: ['36', '37', '38', '39', '40'],    colors: [C.camel, C.azabache] },
];

const CLIENTS = [
  { key: 'c1', name: 'Daniela Quintero',  phone: '+58 412 555 2301', ig: '',                zone: 'Los Pinos',         pay: 'Pago móvil',    channel: 'wa', vip: true,  notes: 'Compra cada quincena. Prefiere entregas después de las 5 pm.' },
  { key: 'c2', name: 'Noelia Arismendi',  phone: '',                 ig: '@noe.arismendi',  zone: 'El Mirador',        pay: 'Zelle',         channel: 'ig', vip: false, notes: 'Talla S en blusas.' },
  { key: 'c3', name: 'Andrés Palacios',   phone: '+58 414 555 2303', ig: '',                zone: 'Centro',            pay: 'Efectivo',      channel: 'wa', vip: false, notes: '' },
  { key: 'c4', name: 'Rocío Villamizar',  phone: '+58 424 555 2304', ig: '',                zone: 'Valle Alto',        pay: 'Transferencia', channel: 'wa', vip: true,  notes: 'Regala a sus sobrinas. Calza 37.' },
  { key: 'c5', name: 'Mariela Sotillo',   phone: '',                 ig: '@marielasotillo', zone: 'Jardines del Este', pay: 'Zelle',         channel: 'ig', vip: false, notes: '' },
  { key: 'c6', name: 'Tomás Echeverri',   phone: '+58 416 555 2306', ig: '',                zone: 'Zona Norte',        pay: 'Tarjeta',       channel: 'wa', vip: false, notes: 'Pide factura a nombre de su empresa.' },
];

// d = días atrás, h = hora; items = [producto, talla, índice de color, cantidad]
const ORDERS = [
  { c: 'c1', d: 0, h: 11, items: [['p4', '38', 1, 1]],                      pay: 'pend', del: 'to_deliver',    payL: 'Pago móvil',    delL: 'Motorizado independiente', ship: 4 },
  { c: 'c2', d: 0, h: 13, items: [['p1', 'S', 0, 1], ['p2', 'M', 0, 1]],    pay: 'ok',   del: 'to_deliver',    payL: 'Zelle',         delL: 'Motorizado independiente', ship: 4 },
  { c: 'c6', d: 0, h: 16, items: [['p3', 'L', 0, 1]],                       pay: 'pend', del: 'to_deliver',    payL: 'Tarjeta',       delL: 'Retiro en tienda',         ship: 0 },
  { c: 'c4', d: 1, h: 10, items: [['p5', '37', 0, 1]],                      pay: 'ok',   del: 'delivered',     payL: 'Transferencia', delL: 'Motorizado independiente', ship: 4 },
  { c: 'c3', d: 1, h: 18, items: [['p4', '41', 0, 1]],                      pay: 'ok',   del: 'delivered',     payL: 'Efectivo',      delL: 'Retiro en tienda',         ship: 0 },
  { c: 'c5', d: 2, h: 12, items: [['p1', 'M', 1, 2]],                       pay: 'pend', del: 'delivered',     payL: 'Zelle',         delL: 'Encomienda',               ship: 6 },
  { c: 'c1', d: 3, h: 17, items: [['p2', 'S', 1, 1], ['p1', 'S', 1, 1]],    pay: 'ok',   del: 'delivered',     payL: 'Pago móvil',    delL: 'Motorizado independiente', ship: 4 },
  { c: 'c2', d: 4, h: 15, items: [['p3', 'S', 1, 1]],                       pay: 'ok',   del: 'delivered',     payL: 'Zelle',         delL: 'Encomienda',               ship: 6 },
  { c: 'c6', d: 5, h: 9,  items: [['p5', '40', 1, 1]],                      pay: 'pend', del: 'not_delivered', payL: 'Tarjeta',       delL: 'Motorizado independiente', ship: 4 },
  { c: 'c4', d: 6, h: 19, items: [['p4', '37', 1, 1], ['p1', 'XS', 0, 1]],  pay: 'ok',   del: 'delivered',     payL: 'Transferencia', delL: 'Motorizado independiente', ship: 4 },
  { c: 'c3', d: 9, h: 14, items: [['p2', 'L', 0, 1]],                       pay: 'ok',   del: 'delivered',     payL: 'Efectivo',      delL: 'Retiro en tienda',         ship: 0 },
];

// m = minutos desde el último mensaje; msgs = [rol, texto]
const CONVOS = [
  { c: 'c1', m: 6, msgs: [
    ['in',  'Buenas tardes 😊 ¿los Tenis Nube tienen talla 38 en verde menta?'],
    ['out', '¡Hola Daniela! Sí, nos queda un par en 38 verde menta. Son $64.'],
    ['in',  '¿Me los mandan hoy a Los Pinos?'],
    ['out', 'Claro, el envío sale a las 5 pm y cuesta $4. ¿Te lo aparto?'],
    ['in',  'Sí porfa, ya te envío el pago móvil 💸'],
  ]},
  { c: 'c2', m: 31, msgs: [
    ['in',  'Holiii, vi la blusa Amapola en tus historias ✨'],
    ['out', '¡Hola Noe! Viene en coral y marfil, desde la XS hasta la L.'],
    ['in',  'Coral en S. Y el palazzo arena en M también 🙈'],
    ['out', 'Perfecto, son $76 + $4 de envío. Te paso el Zelle.'],
    ['in',  'Listo, ya pagué. Te mando el comprobante.'],
  ]},
  { c: 'c6', m: 85, msgs: [
    ['in',  'Hola, ¿tienen la chaqueta denim en índigo talla L?'],
    ['out', 'Hola Tomás, sí hay. ¿La pasas a buscar o te la enviamos?'],
    ['in',  'Paso esta tarde por la tienda. ¿Aceptan tarjeta?'],
    ['out', 'Sí, aceptamos tarjeta. Te esperamos hasta las 7 pm 👍'],
  ]},
  { c: 'c4', m: 200, msgs: [
    ['in',  '¡Los botines llegaron perfectos! A mi sobrina le encantaron 💛'],
    ['out', '¡Qué alegría, Rocío! Gracias por confiar en nosotros 🙏'],
    ['in',  '¿Van a sacar más colores?'],
    ['out', 'El mes que viene llega el Chelsea en vino tinto. Te aviso primero ⭐'],
  ]},
  { c: 'c5', m: 340, msgs: [
    ['in',  'Hola, me llegaron las blusas pero todavía no te he pagado 😅 ¿te pago el lunes?'],
    ['out', 'Hola Mariela, sin problema. Te dejo aquí los datos de Zelle.'],
    ['in',  'Mil gracias, el lunes temprano te escribo.'],
  ]},
  { c: 'c3', m: 1600, msgs: [
    ['in',  '¿Los Tenis Nube vienen en 41?'],
    ['out', 'Sí Andrés, en blanco hueso nos queda la 41.'],
    ['in',  'Paso hoy en la tarde, pago en efectivo.'],
    ['out', 'Perfecto, te los dejamos separados 👟'],
  ]},
  { lead: { id: 'l1', name: 'Lucía Benavides', channel: 'ig' }, m: 14, msgs: [
    ['in',  'Hola!! ¿Cuánto cuesta el botín Chelsea? 😍'],
    ['in',  '¿Hay en 36?'],
  ]},
  { lead: { id: 'l2', name: 'Óscar Lameda', channel: 'wa', phone: '+58 412 555 2308' }, m: 2900, msgs: [
    ['in',  'Buenas, ¿hacen envíos a otras ciudades?'],
    ['out', 'Hola Óscar, sí, enviamos por encomienda. Llega en 24 a 48 horas 📦'],
    ['in',  'Excelente, la semana que viene les pido unos tenis.'],
  ]},
];

function money(n) { return Math.round(n * 100) / 100; }

async function wipeDemoData(client, tenantId) {
  const { rows } = await client.query('SELECT is_demo FROM tenants WHERE id = $1', [tenantId]);
  if (!rows[0]?.is_demo) throw new Error('Solo se pueden vaciar cuentas demo');
  await client.query('DELETE FROM messages WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM conversations WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM order_items WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM orders WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM clients WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM catalog_products WHERE tenant_id = $1', [tenantId]);
}

async function seedDemoTenant(client, tenantId, { city = 'Ciudad Demo' } = {}) {
  const now = Date.now();
  const at = (days, hour) => {
    const d = new Date(now - days * 86400000);
    d.setHours(hour, Math.floor(Math.random() * 50) + 5, 0, 0);
    if (d.getTime() > now) d.setTime(now - 15 * 60000);
    return d;
  };

  const productIds = {};
  for (const p of PRODUCTS) {
    const { rows } = await client.query(
      `INSERT INTO catalog_products (tenant_id, category_key, category_name, category_emoji, name, price, emoji, sizes, colors)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [tenantId, p.cat[0], p.cat[1], p.cat[2], p.name, p.price, p.emoji, JSON.stringify(p.sizes), JSON.stringify(p.colors)]
    );
    productIds[p.key] = rows[0].id;
  }

  const clientIds = {};
  for (const [i, c] of CLIENTS.entries()) {
    const { rows } = await client.query(
      `INSERT INTO clients (tenant_id, name, phone, ig, city, zone, address, pay_method, channel, notes, is_vip, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [tenantId, c.name, c.phone || null, c.ig || null, city, c.zone, `${c.zone}, ${city}`, c.pay, c.channel, c.notes || null, c.vip,
       new Date(now - (20 - i * 3) * 86400000)]
    );
    clientIds[c.key] = rows[0].id;
  }

  const byKey = Object.fromEntries(PRODUCTS.map(p => [p.key, p]));
  const clientByKey = Object.fromEntries(CLIENTS.map(c => [c.key, c]));
  for (const o of ORDERS) {
    const c = clientByKey[o.c];
    const lines = o.items.map(([pk, size, colorIdx, qty]) => {
      const p = byKey[pk];
      return { pk, p, qty, detail: `${p.colors[colorIdx].name} · Talla ${size}`, unit: p.price, line: money(p.price * qty) };
    });
    const subtotal = lines.reduce((s, l) => s + l.line, 0);
    const summary = lines.map(l => `${l.qty > 1 ? l.qty + 'x ' : ''}${l.p.name}`).join(' + ');
    const created = at(o.d, o.h);
    const { rows } = await client.query(
      `INSERT INTO orders (tenant_id, client_id, client_name, platform, product_summary, total_price, pay_status, delivery_status,
         pay_method_label, delivery_method_label, address, notes, shipping, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14) RETURNING id`,
      [tenantId, clientIds[o.c], c.name, c.channel, summary, money(subtotal + o.ship), o.pay, o.del,
       o.payL, o.delL, o.delL.startsWith('Retiro') ? 'Retiro en tienda' : `${c.zone}, ${city}`, null, o.ship, created]
    );
    for (const l of lines) {
      await client.query(
        `INSERT INTO order_items (order_id, tenant_id, product_id, emoji, name, detail, qty, unit_price, line_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [rows[0].id, tenantId, productIds[l.pk], l.p.emoji, l.p.name, l.detail, l.qty, l.unit, l.line]
      );
    }
  }

  for (const cv of CONVOS) {
    const c = cv.lead || { ...clientByKey[cv.c], id: cv.c };
    const isIg = c.channel === 'ig';
    const waId = isIg ? `ig_demo_${c.id}` : c.phone.replace(/\D/g, '');
    const last = new Date(now - cv.m * 60000);
    await client.query(
      `INSERT INTO conversations (wa_id, tenant_id, name, platform, ig_sender_id, last_message_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wa_id, tenant_id) DO NOTHING`,
      [waId, tenantId, c.name, isIg ? 'ig' : 'wa', isIg ? `demo_${c.id}` : null, last]
    );
    const n = cv.msgs.length;
    for (const [i, [role, text]] of cv.msgs.entries()) {
      const t = new Date(last.getTime() - (n - 1 - i) * 3 * 60000);
      await client.query(
        `INSERT INTO messages (id, wa_id, tenant_id, role, type, text, time) VALUES ($1,$2,$3,$4,'text',$5,$6)`,
        [`demo_${waId}_${i}`, waId, tenantId, role, text, t]
      );
    }
  }
}

module.exports = { seedDemoTenant, wipeDemoData, DEMO_DATA: { PRODUCTS, CLIENTS, ORDERS, CONVOS, COLORS: C } };
