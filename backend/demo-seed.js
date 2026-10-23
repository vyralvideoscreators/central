// Datos ficticios para cuentas demo (ropa y calzado).
// Todos los teléfonos usan el prefijo 555, reservado para ficción.

const C = {
  rojo:   { name: 'Rojo',        hex: '#d63c3c' },
  azul:   { name: 'Azul marino', hex: '#1f3a6b' },
  negro:  { name: 'Negro',       hex: '#1a1a1a' },
  celeste:{ name: 'Azul claro',  hex: '#8db8e0' },
  blanco: { name: 'Blanco',      hex: '#f5f5f5' },
  beige:  { name: 'Beige',       hex: '#d9c4a3' },
  nude:   { name: 'Nude',        hex: '#e3bfa6' },
};

const PRODUCTS = [
  { key: 'p1', cat: ['ropa', 'Ropa', '👗'],    name: 'Vestido Floral Midi',   emoji: '👗', price: 38, sizes: ['S', 'M', 'L'],               colors: [C.rojo, C.azul] },
  { key: 'p2', cat: ['ropa', 'Ropa', '👗'],    name: 'Jean Skinny Tiro Alto', emoji: '👖', price: 28, sizes: ['26', '28', '30', '32'],       colors: [C.negro, C.celeste] },
  { key: 'p3', cat: ['ropa', 'Ropa', '👗'],    name: 'Camisa de Lino',        emoji: '👔', price: 25, sizes: ['S', 'M', 'L', 'XL'],         colors: [C.blanco, C.beige] },
  { key: 'p4', cat: ['calzado', 'Calzado', '👟'], name: 'Zapatilla Runner Pro', emoji: '👟', price: 48, sizes: ['37', '38', '39', '40', '41', '42'], colors: [C.blanco, C.negro] },
  { key: 'p5', cat: ['calzado', 'Calzado', '👟'], name: 'Sandalia Plataforma',  emoji: '👡', price: 32, sizes: ['36', '37', '38', '39', '40'], colors: [C.nude, C.negro] },
];

const CLIENTS = [
  { key: 'c1', name: 'María Fernández',  phone: '+58 412 555 0101', ig: '',              zone: 'Chacao',       pay: 'Pago móvil', channel: 'wa', vip: true,  notes: 'Clienta frecuente. Prefiere entregas en la tarde.' },
  { key: 'c2', name: 'Valentina Torres', phone: '',                 ig: '@vale.torres',  zone: 'Las Mercedes', pay: 'Zelle',      channel: 'ig', vip: false, notes: 'Talla M en vestidos.' },
  { key: 'c3', name: 'Carlos Mendoza',   phone: '+58 414 555 0103', ig: '',              zone: 'El Rosal',     pay: 'Efectivo',   channel: 'wa', vip: false, notes: '' },
  { key: 'c4', name: 'Luisa Martínez',   phone: '+58 424 555 0104', ig: '',              zone: 'Los Palos Grandes', pay: 'Pago móvil', channel: 'wa', vip: true, notes: 'Compra para ella y su hija. Calza 38.' },
  { key: 'c5', name: 'Sofía Ramos',      phone: '',                 ig: '@sofiaramos_',  zone: 'Altamira',     pay: 'Zelle',      channel: 'ig', vip: false, notes: '' },
  { key: 'c6', name: 'Pedro Gutiérrez',  phone: '+58 412 555 0106', ig: '',              zone: 'La Castellana', pay: 'Binance',   channel: 'wa', vip: false, notes: 'Pide factura con RIF.' },
];

// d = días atrás, h = hora del día
const ORDERS = [
  { c: 'c1', d: 0, h: 10, items: [['p1', 'M', 0, 1]],                pay: 'pend', del: 'to_deliver',    payL: 'Pago móvil', delL: 'Motorizado independiente', ship: 3 },
  { c: 'c2', d: 0, h: 12, items: [['p4', '39', 0, 1], ['p2', '28', 0, 1]], pay: 'ok', del: 'to_deliver', payL: 'Zelle', delL: 'Motorizado independiente', ship: 3 },
  { c: 'c6', d: 0, h: 15, items: [['p3', 'L', 1, 2]],                pay: 'pend', del: 'to_deliver',    payL: 'Binance',    delL: 'Retiro en tienda',         ship: 0 },
  { c: 'c4', d: 1, h: 11, items: [['p5', '38', 0, 2]],               pay: 'ok',   del: 'delivered',     payL: 'Pago móvil', delL: 'Motorizado independiente', ship: 3 },
  { c: 'c3', d: 1, h: 17, items: [['p4', '42', 1, 1]],               pay: 'ok',   del: 'delivered',     payL: 'Efectivo',   delL: 'Retiro en tienda',         ship: 0 },
  { c: 'c5', d: 2, h: 13, items: [['p1', 'S', 1, 1]],                pay: 'pend', del: 'delivered',     payL: 'Zelle',      delL: 'Encomienda',               ship: 5 },
  { c: 'c1', d: 3, h: 16, items: [['p2', '30', 1, 1], ['p3', 'M', 0, 1]], pay: 'ok', del: 'delivered', payL: 'Pago móvil', delL: 'Motorizado independiente', ship: 3 },
  { c: 'c2', d: 4, h: 10, items: [['p5', '37', 1, 1]],               pay: 'ok',   del: 'delivered',     payL: 'Zelle',      delL: 'Encomienda',               ship: 5 },
  { c: 'c6', d: 5, h: 14, items: [['p4', '41', 0, 1]],               pay: 'pend', del: 'not_delivered', payL: 'Binance',    delL: 'Motorizado independiente', ship: 3 },
  { c: 'c4', d: 6, h: 18, items: [['p1', 'L', 0, 1], ['p5', '38', 1, 1]], pay: 'ok', del: 'delivered', payL: 'Pago móvil', delL: 'Motorizado independiente', ship: 3 },
  { c: 'c3', d: 8, h: 12, items: [['p2', '32', 0, 2]],               pay: 'ok',   del: 'delivered',     payL: 'Efectivo',   delL: 'Retiro en tienda',         ship: 0 },
];

// m = minutos atrás del último mensaje; msgs: [role, text]
const CONVOS = [
  { c: 'c1', m: 4, msgs: [
    ['in',  '¡Hola! ¿Tienen el vestido floral en talla M? 😍'],
    ['out', '¡Hola María! Sí, tenemos en rojo y azul marino. ¿Cuál prefieres?'],
    ['in',  'El rojo porfa. ¿Me lo pueden llevar hoy a Chacao?'],
    ['out', 'Claro, el motorizado sale a las 4pm. Serían $38 + $3 de envío.'],
    ['in',  'Perfecto, ya te hago el pago móvil 🙌'],
  ]},
  { c: 'c2', m: 25, msgs: [
    ['in',  'Holaa, vi las Runner Pro en sus historias 👟'],
    ['out', '¡Hola Vale! Sí, quedan en blanco y negro. ¿Qué talla usas?'],
    ['in',  '39. Y también quiero el jean skinny en 28'],
    ['out', 'Listo, te queda en $76 + envío. Te paso los datos de Zelle.'],
    ['in',  'Ya pagué, te mando el capture ✨'],
  ]},
  { c: 'c6', m: 70, msgs: [
    ['in',  'Buenas, necesito 2 camisas de lino talla L en beige'],
    ['out', 'Buenas Pedro, sí hay disponibles. ¿Paso a retiro o envío?'],
    ['in',  'Paso a buscarlas. ¿Aceptan Binance?'],
    ['out', 'Sí aceptamos. Te paso la dirección de la tienda 📍'],
  ]},
  { c: 'c4', m: 180, msgs: [
    ['in',  '¡Me encantaron las sandalias! Llegaron perfectas 💕'],
    ['out', '¡Qué alegría Luisa! Gracias por tu compra 🙏'],
    ['in',  '¿Les entra mercancía nueva pronto?'],
    ['out', 'La próxima semana llegan colores nuevos, te aviso primero ⭐'],
  ]},
  { c: 'c5', m: 300, msgs: [
    ['in',  'Hola! El vestido me llegó pero aún no te he pagado, ¿te puedo pagar mañana?'],
    ['out', 'Hola Sofía, claro que sí. Te dejo los datos de Zelle por aquí.'],
    ['in',  'Gracias 🙏 mañana a primera hora'],
  ]},
  { c: 'c3', m: 1500, msgs: [
    ['in',  '¿Las Runner Pro vienen en 42?'],
    ['out', 'Sí Carlos, en negro tenemos 42 disponible.'],
    ['in',  'Paso hoy a buscarlas, pago en efectivo'],
    ['out', 'Perfecto, te esperamos 👍'],
  ]},
  { c: 'c6', m: 7200, convoSuffix: 'b', msgs: [
    ['in',  'El motorizado no me encontró ayer 😕'],
    ['out', 'Disculpa Pedro, lo reprogramamos. ¿A qué hora estás en casa?'],
  ]},
  { c: 'c2', m: 9000, convoSuffix: 'b', msgs: [
    ['in',  '¿Hacen envíos a Valencia?'],
    ['out', 'Sí, por encomienda MRW o Zoom. Llega en 24-48h 📦'],
  ]},
];

function money(n) { return Math.round(n * 100) / 100; }

async function seedDemoTenant(client, tenantId, { city = 'Caracas' } = {}) {
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
      const color = p.colors[colorIdx];
      return { pk, p, qty, detail: `${color.name} · Talla ${size}`, unit: p.price, line: money(p.price * qty) };
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
    const c = clientByKey[cv.c];
    const isIg = c.channel === 'ig';
    const base = isIg ? `ig_demo_${cv.c}` : c.phone.replace(/\D/g, '');
    const waId = base + (cv.convoSuffix ? `_${cv.convoSuffix}` : '');
    const last = new Date(now - cv.m * 60000);
    await client.query(
      `INSERT INTO conversations (wa_id, tenant_id, name, platform, ig_sender_id, last_message_at)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (wa_id, tenant_id) DO NOTHING`,
      [waId, tenantId, c.name, isIg ? 'ig' : 'wa', isIg ? `demo_${cv.c}` : null, last]
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

module.exports = { seedDemoTenant };
