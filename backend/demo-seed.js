// Datos 100 % inventados para las cuentas demo (ropa y calzado).
// Nada de aquí puede coincidir con datos reales ni con los datos de prueba
// originales de la app: test/demo-data.test.js lo comprueba.
// Teléfonos con el bloque 555-2xxx, reservado para ficción.

const { recalcOrderPayment } = require('./pagos');
const ops = require('./operacion');

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

// cost = costo por unidad (p3 sin costo, para que se vea el aviso de «ventas sin costo»); stock = unidades iniciales por
// variante en los productos con control de existencias (stockZero = variantes que empiezan en 0 y quedan en negativo al vender)
const PRODUCTS = [
  { key: 'p1', cat: ['prendas', 'Prendas', '👚'], name: 'Blusa Bordada Amapola',  emoji: '👚', price: 34, sizes: ['XS', 'S', 'M', 'L'],            colors: [C.coral, C.marfil], cost: 14, stock: 5 },
  { key: 'p2', cat: ['prendas', 'Prendas', '👚'], name: 'Pantalón Palazzo Brisa', emoji: '👖', price: 42, sizes: ['S', 'M', 'L', 'XL'],            colors: [C.arena, C.oliva], cost: 18 },
  { key: 'p3', cat: ['prendas', 'Prendas', '👚'], name: 'Chaqueta Denim Cropped', emoji: '🧥', price: 56, sizes: ['S', 'M', 'L'],                  colors: [C.indigo, C.humo] },
  { key: 'p4', cat: ['zapatos', 'Zapatos', '👟'], name: 'Tenis Urbano Nube',      emoji: '👟', price: 64, sizes: ['36', '37', '38', '39', '40', '41'], colors: [C.hueso, C.menta], cost: 27, stock: 3, stockZero: [['41', 0]] },
  { key: 'p5', cat: ['zapatos', 'Zapatos', '👟'], name: 'Botín Chelsea Siena',    emoji: '👢', price: 79, sizes: ['36', '37', '38', '39', '40'],    colors: [C.camel, C.azabache], cost: 33, stock: 2 },
];

// Gastos de ejemplo: d = días atrás; void = anulado (registrado dos veces)
const EXPENSES = [
  { d: 0, amount: 12,  cat: 'Envíos',               method: 'Efectivo',      note: 'Combustible del motorizado' },
  { d: 1, amount: 60,  cat: 'Publicidad',           method: 'Transferencia',        note: 'Impulso de publicaciones en redes' },
  { d: 2, amount: 35,  cat: 'Servicios',            method: 'Pago móvil',    note: 'Internet del local' },
  { d: 2, amount: 25,  cat: 'Otros',                method: 'Efectivo',      note: 'Bolsas y papel de regalo', void: 'Registrado dos veces' },
  { d: 3, amount: 220, cat: 'Compras de mercancía', method: 'Transferencia', note: 'Reposición de tenis y botines' },
  { d: 4, amount: 15,  cat: 'Envíos',               method: 'Efectivo',      note: 'Encomienda de una clienta' },
  { d: 5, amount: 90,  cat: 'Alquiler',             method: 'Zelle',         note: 'Parte del mes del local compartido' },
  { d: 6, amount: 8.5, cat: 'Otros',                method: 'Efectivo',      note: 'Etiquetas y cinta' },
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
  { c: 'c5', d: 2, h: 12, items: [['p1', 'M', 1, 2]],                       pay: 'pend', paid: 30, del: 'delivered',     payL: 'Zelle',         delL: 'Encomienda',               ship: 6 },
  { c: 'c1', d: 3, h: 17, items: [['p2', 'S', 1, 1], ['p1', 'S', 1, 1]],    pay: 'ok', ves: 38.5, voidedDup: true,   del: 'delivered',     payL: 'Pago móvil',    delL: 'Motorizado independiente', ship: 4 },
  { c: 'c2', d: 4, h: 15, items: [['p3', 'S', 1, 1]],                       pay: 'ok',   del: 'delivered',     payL: 'Zelle',         delL: 'Encomienda',               ship: 6 },
  { c: 'c6', d: 5, h: 9,  items: [['p5', '40', 1, 1]],                      pay: 'pend', paid: 40, del: 'not_delivered', payL: 'Tarjeta',       delL: 'Motorizado independiente', ship: 4 },
  { c: 'c4', d: 6, h: 19, items: [['p4', '37', 1, 1], ['p1', 'XS', 0, 1]],  pay: 'ok',   del: 'delivered',     payL: 'Transferencia', delL: 'Motorizado independiente', ship: 4 },
  { c: 'c3', d: 9, h: 14, items: [['p2', 'L', 0, 1]],                       pay: 'ok',   del: 'delivered',     payL: 'Efectivo',      delL: 'Retiro en tienda',         ship: 0 },
  // Fase 3: estados intermedios, un pedido anulado, una devolución con saldo a favor y dos presupuestos
  { c: 'c5', d: 0, h: 9,  items: [['p2', 'S', 0, 1]],                       pay: 'pend', del: 'preparing',     payL: 'Zelle',         delL: 'Motorizado independiente', ship: 4, dz: 'Jardines del Este', dd: 1 },
  { c: 'c3', d: 1, h: 15, items: [['p5', '39', 1, 1]],                      pay: 'ok',   del: 'on_the_way',    payL: 'Efectivo',      delL: 'Motorizado independiente', ship: 4, dz: 'Centro', dd: 0 },
  { c: 'c6', d: 4, h: 11, items: [['p1', 'M', 0, 1]],                       pay: 'pend', del: 'cancelled',     payL: 'Tarjeta',       delL: 'Retiro en tienda',         ship: 0, cancelReason: 'El cliente cambió de opinión antes del pago' },
  { c: 'c4', d: 7, h: 13, items: [['p5', '38', 0, 1]],                      pay: 'ok',   del: 'delivered',     payL: 'Transferencia', delL: 'Motorizado independiente', ship: 4, dz: 'Valle Alto',
    ret: { reason: 'Le quedó pequeño: devolvió el par y dejó el dinero como saldo a favor' } },
  { c: 'c2', d: 1, h: 17, items: [['p3', 'M', 1, 1], ['p1', 'XS', 1, 1]],   pay: 'pend', del: 'to_deliver',    payL: 'Zelle',         delL: 'Motorizado independiente', ship: 4, quote: true },
  { c: 'c6', d: 2, h: 10, items: [['p4', '40', 0, 2]],                      pay: 'pend', del: 'to_deliver',    payL: 'Tarjeta',       delL: 'Retiro en tienda',         ship: 0, quote: true },
];

// Zonas de entrega de ejemplo (impuesto apagado)
const ZONES = [
  { name: 'Los Pinos', cost: 4 }, { name: 'El Mirador', cost: 4 }, { name: 'Centro', cost: 3 },
  { name: 'Valle Alto', cost: 5 }, { name: 'Jardines del Este', cost: 6 },
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

// Fase 4B: dos usuarios inventados para probar los roles (Encargado y Vendedor). Su correo es de un dominio de prueba (nunca se les
// envía nada) y su contraseña la muestra el panel admin al crear o reiniciar la demo. Devuelve [{ name, role, email, password }].
// El upsert NO reactiva ni cambia el rol de un usuario existente (si el prospecto desactivó o cambió a alguien, «Nueva clave» solo
// renueva su clave) y devuelve el rol y el estado REALES. Si no devuelve fila (el correo es de otro negocio) falla en voz alta.
const TEAM = [['Marta Encargada', 'manager', 'encargado'], ['Víctor Vendedor', 'seller', 'vendedor']]; // también lo revisa demo-data.test.js
async function seedDemoTeam(client, tenantId) {
  const bcrypt = require('bcrypt');
  const { generateTempPassword } = require('./equipo');
  const tag = String(tenantId).replace(/-/g, '').slice(0, 8);
  const out = [];
  for (const [name, role, prefix] of TEAM) {
    const password = generateTempPassword();
    const email = `${prefix}.${tag}@demo.central.test`;
    const { rows: [u] } = await client.query(`INSERT INTO team_users (tenant_id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash,
        must_change_password = false, temp_password_expires_at = NULL, token_version = team_users.token_version + 1
      WHERE team_users.tenant_id = EXCLUDED.tenant_id RETURNING id, role, active`, [tenantId, name, email, await bcrypt.hash(password, 10), role]);
    if (!u) throw new Error(`No se pudo crear el usuario de ejemplo ${email}: ese correo ya pertenece a otro negocio`);
    out.push({ id: u.id, name, role: u.role, active: u.active, email, password });
  }
  return out;
}

async function wipeDemoData(client, tenantId) {
  const { rows } = await client.query('SELECT is_demo FROM tenants WHERE id = $1', [tenantId]);
  if (!rows[0]?.is_demo) throw new Error('Solo se pueden vaciar cuentas demo');
  // Fase 4B: los usuarios del equipo que no son el dueño (los inventados y los que creó el prospecto)
  await client.query(`DELETE FROM team_users WHERE tenant_id = $1 AND role <> 'owner'`, [tenantId]);
  // Fase 4A: gastos, cierres de caja y existencias (los niveles y movimientos caen con el producto, pero se borran explícitos)
  await client.query('DELETE FROM stock_movements WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM stock_levels WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM expenses WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM cash_closings WHERE tenant_id = $1', [tenantId]);
  // Fase 3: primero lo que cuelga de pedidos y clientes (reembolsos, notas de crédito, saldo a favor)
  await client.query('DELETE FROM client_credit_entries WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM refunds WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM credit_note_items WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM credit_notes WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM payments WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM order_events WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM messages WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM conversations WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM order_items WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM orders WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM clients WHERE tenant_id = $1', [tenantId]);
  await client.query('DELETE FROM catalog_products WHERE tenant_id = $1', [tenantId]);
  await client.query(`UPDATE tenants SET order_seq = 0, quote_seq = 0, credit_note_seq = 0, base_currency = 'USD' WHERE id = $1 AND is_demo = true`, [tenantId]);
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
      `INSERT INTO catalog_products (tenant_id, category_key, category_name, category_emoji, name, price, emoji, sizes, colors, cost, track_stock)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [tenantId, p.cat[0], p.cat[1], p.cat[2], p.name, p.price, p.emoji, JSON.stringify(p.sizes), JSON.stringify(p.colors),
       p.cost === undefined ? null : p.cost, p.stock !== undefined]
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
  const stockMoves = [];
  const clientByKey = Object.fromEntries(CLIENTS.map(c => [c.key, c]));
  for (const o of ORDERS) {
    const c = clientByKey[o.c];
    const lines = o.items.map(([pk, size, colorIdx, qty]) => {
      const p = byKey[pk];
      return { pk, p, qty, detail: `${p.colors[colorIdx].name} · Talla ${size}`, unit: p.price, line: money(p.price * qty),
        vkey: ops.buildVariantKey(size, p.colors[colorIdx].name) };
    });
    const subtotal = lines.reduce((s, l) => s + l.line, 0);
    const summary = lines.map(l => `${l.qty > 1 ? l.qty + 'x ' : ''}${l.p.name}`).join(' + ');
    const created = at(o.d, o.h);
    const dDate = o.dd === undefined ? null : new Date(now + o.dd * 86400000).toISOString().slice(0, 10);
    const cancelled = o.del === 'cancelled';
    const { rows } = await client.query(
      `INSERT INTO orders (tenant_id, client_id, client_name, platform, product_summary, total_price, pay_status, delivery_status,
         pay_method_label, delivery_method_label, address, notes, shipping, created_at, updated_at,
         kind, delivery_zone, delivery_date, cancelled_at, cancel_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [tenantId, clientIds[o.c], c.name, c.channel, summary, money(subtotal + o.ship), 'pend', o.del,
       o.payL, o.delL, o.delL.startsWith('Retiro') ? 'Retiro en tienda' : `${c.zone}, ${city}`, null, o.ship, created,
       o.quote ? 'quote' : 'order', o.dz || null, dDate, cancelled ? new Date(created.getTime() + 3600000) : null, cancelled ? o.cancelReason : null]
    );
    const itemIds = [];
    for (const l of lines) {
      const { rows: ir } = await client.query(
        `INSERT INTO order_items (order_id, tenant_id, product_id, emoji, name, detail, qty, unit_price, line_price, variant_key, unit_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [rows[0].id, tenantId, productIds[l.pk], l.p.emoji, l.p.name, l.detail, l.qty, l.unit, l.line, l.vkey,
         o.quote || l.p.cost === undefined ? null : l.p.cost]
      );
      itemIds.push(ir[0].id);
      // Existencias: un pedido (no un presupuesto) descontó lo vendido; si se anuló, volvió
      if (!o.quote && l.p.stock !== undefined) {
        stockMoves.push({ pk: l.pk, vkey: l.vkey, delta: -l.qty, reason: 'sale', orderId: rows[0].id, at: created });
        if (cancelled) stockMoves.push({ pk: l.pk, vkey: l.vkey, delta: l.qty, reason: 'cancel', orderId: rows[0].id, at: new Date(created.getTime() + 3600000) });
      }
    }

    // Cobros coherentes: pagado completo ('ok'), abonado (paid) o sin cobrar; uno en bolívares y uno anulado
    const orderId = rows[0].id, total = money(subtotal + o.ship);
    const events = [['created', { total, items: lines.length, clientName: c.name, platform: c.channel }, created]];
    const pays = [];
    const full = o.pay === 'ok';
    if (full || o.paid) {
      const amountBase = full ? total : o.paid;
      const ves = full && o.ves;
      pays.push({ amountBase, amount: ves ? money(amountBase * o.ves) : amountBase, currency: ves ? 'VES' : 'USD', rate: ves ? o.ves : 1,
        reference: /Zelle|Pago móvil|Transferencia/.test(o.payL) ? String(100000 + Math.floor(Math.random() * 899999)) : null, voided: false });
    }
    if (o.voidedDup) pays.push({ amountBase: total, amount: total, currency: 'USD', rate: 1, reference: null, voided: true });
    for (const p of pays) {
      const { rows: pr } = await client.query(
        `INSERT INTO payments (tenant_id, order_id, client_id, amount, currency, exchange_rate, amount_base, method, reference,
           paid_at, created_at, voided_at, void_reason, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,'owner') RETURNING id`,
        [tenantId, orderId, clientIds[o.c], p.amount, p.currency, p.rate, p.amountBase, o.payL, p.reference, created,
         p.voided ? new Date(created.getTime() + 20 * 60000) : null, p.voided ? 'Registrado dos veces' : null]);
      events.push(['payment_added', { paymentId: pr[0].id, amount: p.amount, currency: p.currency, amountBase: p.amountBase, method: o.payL, reference: p.reference }, created]);
      if (p.voided) events.push(['payment_voided', { paymentId: pr[0].id, amountBase: p.amountBase, method: o.payL, reason: 'Registrado dos veces' }, new Date(created.getTime() + 20 * 60000)]);
    }
    if (o.del === 'delivered') events.push(['status_changed', { from: 'to_deliver', to: 'delivered' }, new Date(Math.min(now, created.getTime() + 3 * 3600000))]);
    if (o.del === 'preparing' || o.del === 'on_the_way') events.push(['status_changed', { from: 'to_deliver', to: o.del }, new Date(Math.min(now, created.getTime() + 2 * 3600000))]);
    if (cancelled) events.push(['cancelled', { reason: o.cancelReason, from: 'to_deliver', resolution: null, refundedBase: 0 }, new Date(created.getTime() + 3600000)]);
    for (const [type, data, when] of events) {
      await client.query('INSERT INTO order_events (tenant_id, order_id, type, data, created_at) VALUES ($1,$2,$3,$4,$5)',
        [tenantId, orderId, type, JSON.stringify(data), when]);
    }
    await recalcOrderPayment(client, tenantId, orderId);
    // Devolución de un artículo con el dinero dejado como saldo a favor del cliente (nota NC-0001)
    if (o.ret) {
      const l0 = lines[0], l0Amount = l0.line;
      const when = new Date(Math.min(now, created.getTime() + 2 * 86400000));
      const { rows: [cn] } = await client.query(
        `INSERT INTO credit_notes (tenant_id, order_id, client_id, number, amount_base, reason, created_at)
         VALUES ($1,$2,$3,1,$4,$5,$6) RETURNING id`, [tenantId, orderId, clientIds[o.c], l0Amount, o.ret.reason, when]);
      await client.query(`INSERT INTO credit_note_items (tenant_id, credit_note_id, order_item_id, name, qty, amount)
        VALUES ($1,$2,$3,$4,$5,$6)`, [tenantId, cn.id, itemIds[0], l0.p.name, l0.qty, l0Amount]);
      const { rows: [rf] } = await client.query(
        `INSERT INTO refunds (tenant_id, order_id, credit_note_id, amount, currency, exchange_rate, amount_base, method, reason, created_at)
         VALUES ($1,$2,$3,$4,'USD',1,$4,'Saldo a favor',$5,$6) RETURNING id`, [tenantId, orderId, cn.id, l0Amount, o.ret.reason, when]);
      await client.query(`INSERT INTO client_credit_entries (tenant_id, client_id, amount, kind, order_id, ref_id, created_at)
        VALUES ($1,$2,$3,'refund_to_credit',$4,$5,$6)`, [tenantId, clientIds[o.c], l0Amount, orderId, rf.id, when]);
      await client.query('UPDATE tenants SET credit_note_seq = 1 WHERE id = $1', [tenantId]);
      if (l0.p.stock !== undefined) stockMoves.push({ pk: l0.pk, vkey: l0.vkey, delta: l0.qty, reason: 'return', orderId, at: when, note: 'NC-0001' });
      for (const [type, data] of [
        ['returned', { creditNoteId: cn.id, number: 'NC-0001', amountBase: l0Amount, reason: o.ret.reason, resolution: 'credit', items: [{ name: l0.p.name, qty: l0.qty }] }],
        ['refunded', { refundId: rf.id, amountBase: l0Amount, method: 'Saldo a favor', creditNoteId: cn.id, reason: o.ret.reason }],
      ]) await client.query('INSERT INTO order_events (tenant_id, order_id, type, data, created_at) VALUES ($1,$2,$3,$4,$5)',
        [tenantId, orderId, type, JSON.stringify(data), when]);
      await recalcOrderPayment(client, tenantId, orderId);
    }
    // recalcOrderPayment toca updated_at: un pedido sembrado no debe parecer editado
    await client.query('UPDATE orders SET updated_at = created_at WHERE id = $1 AND tenant_id = $2', [orderId, tenantId]);

  }

  // Numeración propia del negocio: #0001… en orden de fecha, y el contador al día
  await client.query(`
    WITH n AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, order_number) AS rn
      FROM orders WHERE tenant_id = $1 AND kind = 'order'
    )
    UPDATE orders o SET tenant_order_number = n.rn FROM n WHERE o.id = n.id AND o.tenant_id = $1
  `, [tenantId]);
  await client.query(`
    WITH n AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY created_at, order_number) AS rn
      FROM orders WHERE tenant_id = $1 AND kind = 'quote'
    )
    UPDATE orders o SET quote_number = n.rn FROM n WHERE o.id = n.id AND o.tenant_id = $1
  `, [tenantId]);
  await client.query(
    `UPDATE tenants SET order_seq = (SELECT COUNT(*) FROM orders WHERE tenant_id = $1 AND kind = 'order'),
       quote_seq = (SELECT COUNT(*) FROM orders WHERE tenant_id = $1 AND kind = 'quote') WHERE id = $1`,
    [tenantId]
  );
  // Ajustes de ejemplo: zonas de entrega con su costo e impuesto apagado
  await client.query(
    `INSERT INTO tenant_settings (tenant_id, zones, tax) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE SET zones = EXCLUDED.zones, tax = EXCLUDED.tax`,
    [tenantId, JSON.stringify(ZONES), JSON.stringify({ enabled: false, rate: 0, label: 'IVA' })]
  );

  // Existencias: inventario inicial por variante (hace 20 días) + las ventas, anulaciones y la devolución sembradas arriba.
  // Una variante empieza en 0 y queda en negativo (se permite vender sin existencias).
  {
    const moves = [];
    for (const p of PRODUCTS.filter(x => x.stock !== undefined)) {
      for (const v of ops.productVariants(p)) {
        const zero = (p.stockZero || []).some(([size, ci]) => v.size === size && v.color === p.colors[ci].name);
        const qty = zero ? 0 : p.stock;
        moves.push({ pk: p.key, vkey: v.key, delta: 0, level0: true });
        if (qty > 0) moves.push({ pk: p.key, vkey: v.key, delta: qty, reason: 'count', note: 'Inventario inicial', at: new Date(now - 20 * 86400000) });
      }
    }
    const levels = new Map();
    for (const m of moves.filter(x => x.level0)) levels.set(m.pk + '|' + m.vkey, 0);
    const real = moves.filter(x => !x.level0).concat(stockMoves).sort((a, b) => a.at - b.at);
    for (const m of real) {
      const k = m.pk + '|' + m.vkey;
      const after = (levels.get(k) || 0) + m.delta;
      levels.set(k, after);
      await client.query(
        `INSERT INTO stock_movements (tenant_id, product_id, variant_key, delta, qty_after, reason, order_id, note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [tenantId, productIds[m.pk], m.vkey, m.delta, after, m.reason, m.orderId || null, m.note || null, m.at]);
    }
    for (const [k, qty] of levels) {
      const [pk, vkey] = k.split('|');
      await client.query(`INSERT INTO stock_levels (tenant_id, product_id, variant_key, qty) VALUES ($1,$2,$3,$4)`,
        [tenantId, productIds[pk], k.slice(pk.length + 1), qty]);
    }
  }

  // Gastos de ejemplo y el cierre de caja de ayer (con una pequeña diferencia)
  const { rows: [tz0] } = await client.query('SELECT timezone, country FROM tenants WHERE id = $1', [tenantId]);
  const tz = ops.tzOf(tz0) || ops.DEFAULT_TIMEZONE; // las demos nacen con zona (desde su país); Caracas solo como último recurso
  const dayAgo = async (d) => (await client.query(`SELECT to_char((now() - ($1 || ' days')::interval) AT TIME ZONE $2, 'YYYY-MM-DD') AS d`, [String(d), tz])).rows[0].d;
  for (const e of EXPENSES) {
    const made = new Date(now - e.d * 86400000 - 3600000);
    await client.query(
      `INSERT INTO expenses (tenant_id, spent_on, amount, currency, exchange_rate, amount_base, category, method, note, created_at, voided_at, void_reason)
       VALUES ($1,$2::date,$3,'USD',1,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, await dayAgo(e.d), e.amount, e.cat, e.method, e.note, made, e.void ? new Date(made.getTime() + 600000) : null, e.void || null]);
  }
  {
    const day = await dayAgo(1);
    const expected = await ops.computeCashExpected(client, tenantId, day, tz);
    if (expected.length) {
      // Formato por método Y moneda: claves "método|MONEDA" (ver operacion.js → computeCashExpected)
      const exp = {}, cnt = {}, dif = {};
      let shorted = false;
      for (const m of expected) {
        const key = ops.cashKey(m.method, m.currency);
        exp[key] = m.expected;
        let c = Math.max(0, m.expected);
        if (!shorted && c >= 1.5) { c = money(c - 1.5); shorted = true; } // faltaron 1.50 en la caja
        cnt[key] = c;
        dif[key] = money(c - m.expected);
      }
      await client.query(
        `INSERT INTO cash_closings (tenant_id, day, expected, counted, difference, note, closed_at) VALUES ($1,$2::date,$3,$4,$5,$6,$7)`,
        [tenantId, day, JSON.stringify(exp), JSON.stringify(cnt), JSON.stringify(dif), shorted ? 'Faltó cambio en la caja' : null, new Date(now - 18 * 3600000)]);
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

module.exports = { seedDemoTenant, seedDemoTeam, wipeDemoData, DEMO_DATA: { PRODUCTS, CLIENTS, ORDERS, CONVOS, EXPENSES, TEAM, COLORS: C } };
