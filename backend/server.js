// ══════════════════════════════════════════════════════════════
// CENTRAL BACKEND v5.0
// Multi-tenant + PostgreSQL + WhatsApp Business API + Instagram DMs
// ══════════════════════════════════════════════════════════════
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const http       = require('http');
const { WebSocketServer } = require('ws');
const multer     = require('multer');
const FormData   = require('form-data');
const puppeteer  = require('puppeteer');
const { Pool }   = require('pg');
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const Stripe     = require('stripe');
const crypto     = require('crypto');

const app = express();
app.use(cors());
// El webhook de Stripe necesita el body sin procesar para validar la firma
// (ver /api/billing/webhook) — se excluye acá del parser JSON global.
app.use((req, res, next) => {
  if (req.originalUrl === '/api/billing/webhook') return next();
  express.json({ limit: '20mb' })(req, res, next);
});

// Límite de intentos de login por IP: 10 cada 15 min (frena fuerza bruta sobre claves)
app.set('trust proxy', 1);
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.baseUrl + '|' + req.ip;
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (!rec || now > rec.reset) { loginAttempts.set(key, { count: 1, reset: now + 15 * 60000 }); return next(); }
  if (++rec.count > 10) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
  }
  next();
}
setInterval(() => { const n = Date.now(); for (const [k, v] of loginAttempts) if (n > v.reset) loginAttempts.delete(k); }, 10 * 60000).unref();
app.use(['/api/tenant/login', '/api/admin/login'], loginRateLimit);

const PORT             = process.env.PORT || 3000;
const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE       = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const JWT_SECRET       = process.env.JWT_SECRET || 'central_jwt_dev_secret_cambiar_en_prod';

const stripe           = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' }) : null;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PRICE_PRO      = process.env.STRIPE_PRICE_PRO || '';
const STRIPE_PRICE_BUSINESS = process.env.STRIPE_PRICE_BUSINESS || '';
const APP_URL               = process.env.APP_URL || 'https://central-backend-production.up.railway.app';
const RESEND_FROM           = process.env.RESEND_FROM || 'CENTRAL <onboarding@resend.dev>';

// Variables de entorno de compatibilidad (para el tenant por defecto / legacy)
const DEFAULT_PHONE_ID  = process.env.WHATSAPP_PHONE_NUMBER_ID;
const DEFAULT_WA_TOKEN  = process.env.WHATSAPP_TOKEN;
const DEFAULT_IG_TOKEN  = process.env.INSTAGRAM_ACCESS_TOKEN;
const DEFAULT_IG_ACCT   = process.env.INSTAGRAM_ACCOUNT_ID || '17841426682340000';
const VERIFY_TOKEN      = process.env.WEBHOOK_VERIFY_TOKEN || 'central_webhook_secreto_123';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── In-memory media cache (binarios no van a DB) ──────────────
const mediaCache = {};

// ══════════════════════════════════════════════════════════════
// POSTGRESQL
// ══════════════════════════════════════════════════════════════
let pool = null;
let dbReady = false;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

async function initDB() {
  if (!pool) {
    console.warn('⚠️  DATABASE_URL no configurado — datos solo en memoria');
    return;
  }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_name             TEXT NOT NULL,
        full_name                 TEXT,
        email                     TEXT UNIQUE NOT NULL,
        password_hash             TEXT NOT NULL,
        plan                      TEXT DEFAULT 'basic',
        country                   TEXT,
        whatsapp_number           TEXT,
        stripe_customer_id        TEXT,
        stripe_subscription_id    TEXT,
        plan_expires_at           TIMESTAMP,
        billing_status            TEXT DEFAULT 'free',
        whatsapp_phone_number_id  TEXT,
        whatsapp_token            TEXT,
        instagram_access_token    TEXT,
        instagram_account_id      TEXT,
        webhook_verify_token      TEXT DEFAULT 'central_webhook_secreto_123',
        reset_token               TEXT,
        reset_token_expires       TIMESTAMP,
        created_at                TIMESTAMP DEFAULT NOW(),
        active                    BOOLEAN DEFAULT true
      );

      CREATE TABLE IF NOT EXISTS conversations (
        wa_id          TEXT NOT NULL,
        tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name           TEXT,
        platform       TEXT DEFAULT 'wa',
        ig_sender_id   TEXT,
        last_message_at TIMESTAMP,
        PRIMARY KEY (wa_id, tenant_id)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id         TEXT    NOT NULL,
        wa_id      TEXT    NOT NULL,
        tenant_id  UUID    NOT NULL,
        role       TEXT    NOT NULL,
        type       TEXT    NOT NULL,
        text       TEXT,
        media_id   TEXT,
        mime_type  TEXT,
        media_url  TEXT,
        caption    TEXT,
        filename   TEXT,
        order_type TEXT,
        time       TIMESTAMP NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (id, tenant_id),
        FOREIGN KEY (wa_id, tenant_id) REFERENCES conversations(wa_id, tenant_id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS catalog_products (
        id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        category_key   TEXT,
        category_name  TEXT,
        category_emoji TEXT,
        name           TEXT NOT NULL,
        price          NUMERIC(10,2) NOT NULL DEFAULT 0,
        emoji          TEXT,
        sizes          JSONB DEFAULT '[]',
        colors         JSONB DEFAULT '[]',
        description    TEXT,
        created_at     TIMESTAMP DEFAULT NOW(),
        updated_at     TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS clients (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        name            TEXT NOT NULL,
        phone           TEXT,
        ig              TEXT,
        email           TEXT,
        city            TEXT,
        zone            TEXT,
        address         TEXT,
        extra_addresses JSONB DEFAULT '[]',
        pay_method      TEXT,
        channel         TEXT,
        notes           TEXT,
        is_vip          BOOLEAN DEFAULT false,
        created_at      TIMESTAMP DEFAULT NOW(),
        updated_at      TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_number          BIGSERIAL,
        tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        client_id             UUID REFERENCES clients(id) ON DELETE SET NULL,
        client_name           TEXT,
        platform              TEXT,
        product_summary       TEXT,
        total_price           NUMERIC(10,2) DEFAULT 0,
        pay_status            TEXT DEFAULT 'pend',
        delivery_status       TEXT DEFAULT 'to_deliver',
        pay_method_label      TEXT,
        delivery_method_label TEXT,
        address               TEXT,
        notes                 TEXT,
        shipping              NUMERIC(10,2) DEFAULT 0,
        created_at            TIMESTAMP DEFAULT NOW(),
        updated_at            TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        tenant_id   UUID NOT NULL,
        product_id  UUID REFERENCES catalog_products(id) ON DELETE SET NULL,
        emoji       TEXT,
        name        TEXT,
        detail      TEXT,
        qty         INTEGER DEFAULT 1,
        unit_price  NUMERIC(10,2),
        line_price  NUMERIC(10,2)
      );
    `);

    dbReady = true;
    console.log('✅ Base de datos PostgreSQL lista');

    // El seed del tenant por defecto es un extra: si falla, la plataforma debe
    // seguir con persistencia igual, no quedarse sin base de datos. Lo mismo
    // aplica a cualquier migración que se añada aquí en el futuro: va en su
    // propio try, después de dbReady, nunca dentro del bloque principal.
    // Migraciones incrementales — idempotentes, cada una en su propio try
    try {
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS expires_at   TIMESTAMPTZ DEFAULT NULL`);
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_demo      BOOLEAN     DEFAULT false`);
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS demo_days    INTEGER     DEFAULT 7`);
      console.log('✅ Migraciones de demo aplicadas');
    } catch (err) {
      console.error('⚠️  Migración demo:', err.message);
    }

    try {
      await seedDefaultTenant();
    } catch (err) {
      console.error('⚠️  No se pudo sembrar el tenant por defecto:', err.message);
    }
  } catch (err) {
    console.error('⚠️  Error inicializando DB:', err.message);
    console.warn('⚠️  El servidor continuará sin persistencia en DB');
  }
}

async function seedDefaultTenant() {
  const email    = process.env.DEFAULT_TENANT_EMAIL;
  const password = process.env.DEFAULT_TENANT_PASSWORD;
  if (!email || !password) return;

  const { rows } = await pool.query('SELECT id FROM tenants WHERE email = $1', [email]);
  if (rows.length > 0) {
    // Actualizar credenciales de WhatsApp/Instagram si cambiaron
    await pool.query(`
      UPDATE tenants SET
        whatsapp_phone_number_id = COALESCE($1, whatsapp_phone_number_id),
        whatsapp_token           = COALESCE($2, whatsapp_token),
        instagram_access_token   = COALESCE($3, instagram_access_token),
        instagram_account_id     = COALESCE($4, instagram_account_id)
      WHERE email = $5
    `, [DEFAULT_PHONE_ID || null, DEFAULT_WA_TOKEN || null, DEFAULT_IG_TOKEN || null, DEFAULT_IG_ACCT || null, email]);
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  await pool.query(`
    INSERT INTO tenants (business_name, email, password_hash, plan, whatsapp_phone_number_id, whatsapp_token, instagram_access_token, instagram_account_id)
    VALUES ($1, $2, $3, 'basic', $4, $5, $6, $7)
    ON CONFLICT (email) DO NOTHING
  `, ['Mi Negocio', email, hash, DEFAULT_PHONE_ID || null, DEFAULT_WA_TOKEN || null, DEFAULT_IG_TOKEN || null, DEFAULT_IG_ACCT || null]);
  console.log(`✅ Tenant por defecto creado: ${email}`);
}

// ── DB helpers ────────────────────────────────────────────────

async function dbGetOrCreateConvo(waId, name, tenantId, platform = 'wa', igSenderId = null) {
  if (!dbReady) return;
  await pool.query(`
    INSERT INTO conversations (wa_id, tenant_id, name, platform, ig_sender_id, last_message_at)
    VALUES ($1, $2, COALESCE($3, $1), $4, $5, NOW())
    ON CONFLICT (wa_id, tenant_id) DO UPDATE SET
      name            = COALESCE($3, conversations.name),
      last_message_at = NOW()
  `, [waId, tenantId, name || null, platform, igSenderId]);
}

async function dbSaveMessage(msg, waId, tenantId) {
  if (!dbReady || !tenantId) return;
  await pool.query(`
    INSERT INTO messages (id, wa_id, tenant_id, role, type, text, media_id, mime_type, media_url, caption, filename, order_type, time)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT (id, tenant_id) DO NOTHING
  `, [
    msg.id, waId, tenantId, msg.role, msg.type,
    msg.text || null, msg.mediaId || null, msg.mimeType || null,
    msg.mediaUrl || null, msg.caption || null, msg.filename || null,
    msg.orderType || null, new Date(msg.time),
  ]);
}

async function dbGetConversations(tenantId) {
  if (!dbReady) return [];
  const { rows } = await pool.query(`
    SELECT
      c.wa_id, c.name, c.platform, c.ig_sender_id, c.last_message_at,
      COALESCE(
        json_agg(
          json_build_object(
            'id', m.id, 'role', m.role, 'type', m.type, 'text', m.text,
            'mediaId', m.media_id, 'mimeType', m.mime_type, 'mediaUrl', m.media_url,
            'caption', m.caption, 'filename', m.filename, 'orderType', m.order_type,
            'time', to_char(m.time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ) ORDER BY m.time
        ) FILTER (WHERE m.id IS NOT NULL),
        '[]'::json
      ) AS messages
    FROM conversations c
    LEFT JOIN messages m ON m.wa_id = c.wa_id AND m.tenant_id = c.tenant_id
    WHERE c.tenant_id = $1
    GROUP BY c.wa_id, c.tenant_id
    ORDER BY c.last_message_at DESC NULLS LAST
  `, [tenantId]);

  return rows.map(r => ({
    waId:          r.wa_id,
    name:          r.name,
    platform:      r.platform,
    igSenderId:    r.ig_sender_id,
    lastMessageAt: r.last_message_at,
    messages:      r.messages || [],
  }));
}

async function dbGetTenantByPhoneId(phoneNumberId) {
  if (!dbReady) return null;
  const { rows } = await pool.query(
    'SELECT * FROM tenants WHERE whatsapp_phone_number_id = $1 AND active = true LIMIT 1',
    [phoneNumberId]
  );
  return rows[0] || null;
}

async function dbGetTenantByIgAccountId(igAccountId) {
  if (!dbReady) return null;
  const { rows } = await pool.query(
    'SELECT * FROM tenants WHERE instagram_account_id = $1 AND active = true LIMIT 1',
    [igAccountId]
  );
  return rows[0] || null;
}

// ── DB helpers — Pedidos ─────────────────────────────────────

function mapOrderRow(r) {
  return {
    id:                  r.id,
    orderNumber:         '#' + String(r.order_number).padStart(4, '0'),
    clientId:            r.client_id,
    clientName:          r.client_name,
    platform:            r.platform,
    productSummary:      r.product_summary,
    totalPrice:          r.total_price,
    payStatus:           r.pay_status,
    deliveryStatus:      r.delivery_status,
    payMethodLabel:      r.pay_method_label,
    deliveryMethodLabel: r.delivery_method_label,
    address:             r.address,
    notes:               r.notes,
    shipping:            r.shipping,
    createdAt:           r.created_at,
    updatedAt:           r.updated_at,
    items:               r.items || [],
  };
}

async function dbGetOrders(tenantId) {
  if (!dbReady) return [];
  const { rows } = await pool.query(`
    SELECT o.*,
      COALESCE(
        json_agg(
          json_build_object(
            'id', oi.id, 'productId', oi.product_id, 'emoji', oi.emoji,
            'name', oi.name, 'detail', oi.detail, 'qty', oi.qty,
            'unitPrice', oi.unit_price, 'linePrice', oi.line_price
          )
        ) FILTER (WHERE oi.id IS NOT NULL),
        '[]'::json
      ) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id
    WHERE o.tenant_id = $1
    GROUP BY o.id
    ORDER BY o.created_at DESC
  `, [tenantId]);
  return rows.map(mapOrderRow);
}

async function dbCreateOrder(tenantId, data) {
  if (!dbReady) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      INSERT INTO orders (tenant_id, client_id, client_name, platform, product_summary,
        total_price, pay_status, delivery_status, pay_method_label, delivery_method_label,
        address, notes, shipping)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [
      tenantId, data.clientId || null, data.clientName || null, data.platform || null,
      data.productSummary || null, data.totalPrice || 0, data.payStatus || 'pend',
      data.deliveryStatus || 'to_deliver', data.payMethodLabel || null,
      data.deliveryMethodLabel || null, data.address || null, data.notes || null,
      data.shipping || 0,
    ]);
    const order = rows[0];

    for (const item of (data.items || [])) {
      await client.query(`
        INSERT INTO order_items (order_id, tenant_id, product_id, emoji, name, detail, qty, unit_price, line_price)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `, [
        order.id, tenantId, item.productId || null, item.emoji || null, item.name || null,
        item.detail || null, item.qty || 1, item.unitPrice || 0, item.linePrice || 0,
      ]);
    }

    await client.query('COMMIT');
    const { rows: itemRows } = await pool.query(
      'SELECT id, product_id, emoji, name, detail, qty, unit_price, line_price FROM order_items WHERE order_id = $1',
      [order.id]
    );
    order.items = itemRows.map(i => ({
      id: i.id, productId: i.product_id, emoji: i.emoji, name: i.name,
      detail: i.detail, qty: i.qty, unitPrice: i.unit_price, linePrice: i.line_price,
    }));
    return mapOrderRow(order);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function dbUpdateOrder(tenantId, orderId, fields) {
  if (!dbReady) return null;
  const allowed = ['pay_status', 'delivery_status', 'pay_method_label', 'delivery_method_label',
    'address', 'notes', 'client_name', 'product_summary', 'total_price', 'shipping'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = $${i++}`);
    values.push(val);
  }
  if (sets.length === 0) return null;
  sets.push(`updated_at = NOW()`);
  values.push(orderId, tenantId);
  const { rows } = await pool.query(
    `UPDATE orders SET ${sets.join(', ')} WHERE id = $${i++} AND tenant_id = $${i} RETURNING *`,
    values
  );
  if (!rows[0]) return null;
  const { rows: itemRows } = await pool.query(
    'SELECT id, product_id, emoji, name, detail, qty, unit_price, line_price FROM order_items WHERE order_id = $1',
    [orderId]
  );
  rows[0].items = itemRows.map(it => ({
    id: it.id, productId: it.product_id, emoji: it.emoji, name: it.name,
    detail: it.detail, qty: it.qty, unitPrice: it.unit_price, linePrice: it.line_price,
  }));
  return mapOrderRow(rows[0]);
}

// ── DB helpers — Clientes ─────────────────────────────────────

function mapClientRow(r) {
  return {
    id:             r.id,
    name:           r.name,
    phone:          r.phone,
    ig:             r.ig,
    email:          r.email,
    city:           r.city,
    zone:           r.zone,
    address:        r.address,
    extraAddresses: r.extra_addresses || [],
    payMethod:      r.pay_method,
    channel:        r.channel,
    notes:          r.notes,
    isVip:          r.is_vip,
    createdAt:      r.created_at,
    updatedAt:      r.updated_at,
  };
}

async function dbGetClients(tenantId) {
  if (!dbReady) return [];
  const { rows } = await pool.query(
    'SELECT * FROM clients WHERE tenant_id = $1 ORDER BY created_at DESC',
    [tenantId]
  );
  return rows.map(mapClientRow);
}

async function dbUpsertClient(tenantId, data) {
  if (!dbReady) return null;
  if (data.id) {
    const { rows } = await pool.query(`
      UPDATE clients SET
        name = $1, phone = $2, ig = $3, email = $4, city = $5, zone = $6,
        address = $7, extra_addresses = $8, pay_method = $9, channel = $10,
        notes = $11, is_vip = $12, updated_at = NOW()
      WHERE id = $13 AND tenant_id = $14
      RETURNING *
    `, [
      data.name, data.phone || null, data.ig || null, data.email || null,
      data.city || null, data.zone || null, data.address || null,
      JSON.stringify(data.extraAddresses || []), data.payMethod || null,
      data.channel || null, data.notes || null, !!data.isVip, data.id, tenantId,
    ]);
    return rows[0] ? mapClientRow(rows[0]) : null;
  }
  const { rows } = await pool.query(`
    INSERT INTO clients (tenant_id, name, phone, ig, email, city, zone, address,
      extra_addresses, pay_method, channel, notes, is_vip)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    RETURNING *
  `, [
    tenantId, data.name, data.phone || null, data.ig || null, data.email || null,
    data.city || null, data.zone || null, data.address || null,
    JSON.stringify(data.extraAddresses || []), data.payMethod || null,
    data.channel || null, data.notes || null, !!data.isVip,
  ]);
  return mapClientRow(rows[0]);
}

async function dbDeleteClient(tenantId, clientId) {
  if (!dbReady) return false;
  const { rowCount } = await pool.query(
    'DELETE FROM clients WHERE id = $1 AND tenant_id = $2',
    [clientId, tenantId]
  );
  return rowCount > 0;
}

// ── DB helpers — Catálogo ─────────────────────────────────────

function mapProductRow(r) {
  return {
    id:            r.id,
    categoryKey:   r.category_key,
    categoryName:  r.category_name,
    categoryEmoji: r.category_emoji,
    name:          r.name,
    price:         r.price,
    emoji:         r.emoji,
    sizes:         r.sizes || [],
    colors:        r.colors || [],
    description:   r.description,
    createdAt:     r.created_at,
    updatedAt:     r.updated_at,
  };
}

async function dbGetCatalog(tenantId) {
  if (!dbReady) return [];
  const { rows } = await pool.query(
    'SELECT * FROM catalog_products WHERE tenant_id = $1 ORDER BY created_at ASC',
    [tenantId]
  );
  return rows.map(mapProductRow);
}

async function dbUpsertProduct(tenantId, data) {
  if (!dbReady) return null;
  if (data.id) {
    const { rows } = await pool.query(`
      UPDATE catalog_products SET
        category_key = $1, category_name = $2, category_emoji = $3, name = $4,
        price = $5, emoji = $6, sizes = $7, colors = $8, description = $9, updated_at = NOW()
      WHERE id = $10 AND tenant_id = $11
      RETURNING *
    `, [
      data.categoryKey || null, data.categoryName || null, data.categoryEmoji || null,
      data.name, data.price || 0, data.emoji || null,
      JSON.stringify(data.sizes || []), JSON.stringify(data.colors || []),
      data.description || null, data.id, tenantId,
    ]);
    return rows[0] ? mapProductRow(rows[0]) : null;
  }
  const { rows } = await pool.query(`
    INSERT INTO catalog_products (tenant_id, category_key, category_name, category_emoji,
      name, price, emoji, sizes, colors, description)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
  `, [
    tenantId, data.categoryKey || null, data.categoryName || null, data.categoryEmoji || null,
    data.name, data.price || 0, data.emoji || null,
    JSON.stringify(data.sizes || []), JSON.stringify(data.colors || []), data.description || null,
  ]);
  return mapProductRow(rows[0]);
}

async function dbDeleteProduct(tenantId, productId) {
  if (!dbReady) return false;
  const { rowCount } = await pool.query(
    'DELETE FROM catalog_products WHERE id = $1 AND tenant_id = $2',
    [productId, tenantId]
  );
  return rowCount > 0;
}

// ══════════════════════════════════════════════════════════════
// WEBSOCKET — por tenant
// ══════════════════════════════════════════════════════════════
const server = http.createServer(app);
const wss    = new WebSocketServer({ server, path: '/ws' });

// tenantId → Set<WebSocket>
const tenantClients = new Map();

function broadcastToTenant(tenantId, data) {
  const clients = tenantClients.get(String(tenantId));
  if (!clients) return;
  const payload = JSON.stringify(data);
  clients.forEach(ws => { if (ws.readyState === 1) ws.send(payload); });
}

// Fallback: broadcast a todos cuando no hay multi-tenant en DB
function broadcastAll(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === 1) ws.send(payload); });
}

wss.on('connection', (ws) => {
  let tenantId = null;

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'ping') return;
      if (msg.type === 'auth') {
        try {
          const decoded = jwt.verify(msg.token, JWT_SECRET);
          tenantId = String(decoded.tenantId);
          if (!tenantClients.has(tenantId)) tenantClients.set(tenantId, new Set());
          tenantClients.get(tenantId).add(ws);
          const convos = await dbGetConversations(tenantId);
          ws.send(JSON.stringify({ type: 'init', conversations: convos }));
          console.log(`🔌 Tenant ${tenantId} conectado via WebSocket`);
        } catch {
          ws.send(JSON.stringify({ type: 'auth_error', message: 'Token inválido' }));
          // Aun así permitir conexión en modo sin DB (legado)
          ws.send(JSON.stringify({ type: 'init', conversations: [] }));
        }
      }
    } catch {}
  });

  // Compatibilidad: si en 3s no autenticó, enviar init vacío
  const fallbackTimer = setTimeout(() => {
    if (!tenantId && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'init', conversations: [] }));
    }
  }, 3000);

  ws.on('close', () => {
    clearTimeout(fallbackTimer);
    if (tenantId && tenantClients.has(tenantId)) {
      tenantClients.get(tenantId).delete(ws);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// JWT MIDDLEWARE
// ══════════════════════════════════════════════════════════════
async function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autenticado — incluye Authorization: Bearer <token>' });
  }
  let decoded;
  try {
    decoded = jwt.verify(auth.slice(7), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
  // Revalidar en cada petición que la cuenta siga activa — para que una suspensión
  // desde Central Admin bloquee el acceso al instante, no solo en el próximo login.
  if (dbReady && decoded.tenantId) {
    try {
      const { rows } = await pool.query(
        'SELECT active, expires_at, is_demo FROM tenants WHERE id = $1',
        [decoded.tenantId]
      );
      if (!rows[0] || !rows[0].active) {
        return res.status(403).json({ error: 'Tu cuenta ha sido suspendida. Contacta soporte.' });
      }
      if (rows[0].expires_at && new Date(rows[0].expires_at) < new Date()) {
        return res.status(403).json({ error: 'demo_expired', message: 'El período de demo ha finalizado. Contacta a Magic Design para activar tu cuenta.' });
      }
      decoded.isDemo = !!rows[0].is_demo;
    } catch (err) {
      return res.status(500).json({ error: 'Error validando la cuenta' });
    }
  }
  req.tenant = decoded;
  next();
}

async function getTenantCredentials(tenantId) {
  // Prioridad: DB → env vars (compatibilidad)
  if (dbReady && tenantId) {
    const { rows } = await pool.query(
      'SELECT whatsapp_phone_number_id, whatsapp_token, instagram_access_token, instagram_account_id FROM tenants WHERE id = $1',
      [tenantId]
    );
    if (rows[0]) return rows[0];
  }
  return {
    whatsapp_phone_number_id: DEFAULT_PHONE_ID,
    whatsapp_token:           DEFAULT_WA_TOKEN,
    instagram_access_token:   DEFAULT_IG_TOKEN,
    instagram_account_id:     DEFAULT_IG_ACCT,
  };
}

// ══════════════════════════════════════════════════════════════
// PUPPETEER — renderizador de tickets HTML → imagen
// ══════════════════════════════════════════════════════════════
let browserInstance = null;

async function getBrowser() {
  if (browserInstance && browserInstance.isConnected()) return browserInstance;
  const opts = {
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process'],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  } else {
    const fs = require('fs');
    const paths = ['/usr/bin/chromium','/usr/bin/chromium-browser','/nix/var/nix/profiles/default/bin/chromium'];
    const found = paths.find(p => { try { return fs.existsSync(p); } catch { return false; } });
    if (found) opts.executablePath = found;
  }
  browserInstance = await puppeteer.launch(opts);
  return browserInstance;
}

async function renderHtmlToImage(htmlContent, width = 380) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height: 100, deviceScaleFactor: 2 });
    await page.setContent(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,'Segoe UI',Arial,sans-serif;}body{background:#fff;padding:20px;width:${width-40}px;}</style></head><body>${htmlContent}</body></html>`, { waitUntil: 'networkidle0' });
    const body = await page.$('body');
    const box  = await body.boundingBox();
    return await page.screenshot({ type: 'png', clip: { x:0, y:0, width, height: Math.ceil(box.height) } });
  } finally {
    await page.close();
  }
}

// ══════════════════════════════════════════════════════════════
// HELPERS — Media (Meta Graph API)
// ══════════════════════════════════════════════════════════════

async function downloadMediaFromMeta(mediaId, token) {
  const t = token || DEFAULT_WA_TOKEN;
  const urlRes = await axios.get(`${GRAPH_BASE}/${mediaId}`, { headers: { Authorization: `Bearer ${t}` } });
  const { url, mime_type, file_size } = urlRes.data;
  const fileRes = await axios.get(url, { headers: { Authorization: `Bearer ${t}` }, responseType: 'arraybuffer' });
  const buffer = Buffer.from(fileRes.data);
  mediaCache[mediaId] = { buffer, mimeType: mime_type, size: file_size };
  return mediaCache[mediaId];
}

async function uploadMediaToMeta(buffer, mimeType, filename, phoneId, token) {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimeType });
  form.append('messaging_product', 'whatsapp');
  const res = await axios.post(`${GRAPH_BASE}/${phoneId}/media`, form, {
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
  });
  return res.data.id;
}

function whatsappTypeFromMime(mimeType) {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  return 'document';
}

async function sendMediaMessage(waId, mediaId, waType, caption, filename, phoneId, token) {
  const payload = { messaging_product:'whatsapp', to: waId, type: waType, [waType]: { id: mediaId } };
  if (caption && waType !== 'audio') payload[waType].caption = caption;
  if (waType === 'document' && filename) payload[waType].filename = filename;
  const res = await axios.post(`${GRAPH_BASE}/${phoneId}/messages`, payload, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return res.data;
}

// ══════════════════════════════════════════════════════════════
// WEBHOOK — verificación
// ══════════════════════════════════════════════════════════════
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado por Meta');
    return res.status(200).send(challenge);
  }
  console.warn('❌ Verificación de webhook fallida');
  res.sendStatus(403);
});

// ══════════════════════════════════════════════════════════════
// WEBHOOK — Instagram DMs
// ══════════════════════════════════════════════════════════════
async function handleInstagramWebhook(body) {
  try {
    const entry     = body.entry?.[0];
    const messaging = entry?.messaging?.[0];
    if (!messaging) return;

    const senderId = messaging.sender?.id;
    if (!senderId) return;

    // Identificar tenant por INSTAGRAM_ACCOUNT_ID del entry
    const igAccountId = entry.id; // Meta envía el ID de la cuenta IG en entry.id
    let tenantId = null;
    let igToken  = DEFAULT_IG_TOKEN;
    let igAcct   = DEFAULT_IG_ACCT;

    if (senderId === igAcct) return; // eco propio

    const tenant = await dbGetTenantByIgAccountId(igAccountId);
    if (tenant) {
      tenantId = tenant.id;
      igToken  = tenant.instagram_access_token;
      igAcct   = tenant.instagram_account_id;
      if (senderId === igAcct) return;
    }

    const msgData = messaging.message;
    if (!msgData) return;

    let senderName = senderId;
    try {
      const profileRes = await axios.get(
        `https://graph.instagram.com/${GRAPH_API_VERSION}/${senderId}`,
        { params: { fields: 'name,username', access_token: igToken } }
      );
      senderName = profileRes.data.name || profileRes.data.username || senderId;
    } catch {}

    const convoKey = `ig_${senderId}`;
    await dbGetOrCreateConvo(convoKey, senderName, tenantId, 'ig', senderId);

    const newMessage = {
      id:   msgData.mid || 'ig_' + Date.now(),
      role: 'in',
      type: msgData.attachments ? 'image' : 'text',
      text: msgData.text || (msgData.attachments ? '[Archivo adjunto]' : '[Mensaje vacío]'),
      time: new Date().toISOString(),
    };

    await dbSaveMessage(newMessage, convoKey, tenantId);
    console.log(`📸 Instagram DM de ${senderName}: ${newMessage.text}`);

    const broadcastData = { type:'new_message', waId:convoKey, name:senderName, platform:'ig', message:newMessage };
    if (tenantId) broadcastToTenant(tenantId, broadcastData);
    else broadcastAll(broadcastData);
  } catch (err) {
    console.error('Error procesando webhook Instagram:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// WEBHOOK — WhatsApp Business
// ══════════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    if (body.object === 'instagram') {
      await handleInstagramWebhook(body);
      return;
    }

    if (body.object !== 'whatsapp_business_account') return;

    const entry  = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value  = change?.value;

    // Identificar tenant por phone_number_id
    const phoneNumberId = value?.metadata?.phone_number_id;
    let tenantId  = null;
    let waToken   = DEFAULT_WA_TOKEN;
    let phoneId   = DEFAULT_PHONE_ID;

    const tenant = phoneNumberId ? await dbGetTenantByPhoneId(phoneNumberId) : null;
    if (tenant) {
      tenantId = tenant.id;
      waToken  = tenant.whatsapp_token;
      phoneId  = tenant.whatsapp_phone_number_id;
    }

    const messages = value?.messages;
    if (!messages || messages.length === 0) {
      const statuses = value?.statuses;
      if (statuses?.length > 0) {
        statuses.forEach(st => {
          const data = { type:'message_status', messageId:st.id, status:st.status, waId:st.recipient_id };
          if (tenantId) broadcastToTenant(tenantId, data);
          else broadcastAll(data);
        });
      }
      return;
    }

    for (const msg of messages) {
      const waId        = msg.from;
      const contactName = value.contacts?.[0]?.profile?.name || waId;

      await dbGetOrCreateConvo(waId, contactName, tenantId, 'wa');

      let newMessage = { id: msg.id, role:'in', time: new Date(parseInt(msg.timestamp) * 1000).toISOString() };

      if (msg.type === 'text') {
        newMessage.type = 'text';
        newMessage.text = msg.text.body;
      } else if (['image','audio','video','document','sticker'].includes(msg.type)) {
        const info = msg[msg.type];
        newMessage.type     = msg.type === 'sticker' ? 'image' : msg.type;
        newMessage.mediaId  = info.id;
        newMessage.mimeType = info.mime_type;
        newMessage.caption  = info.caption || '';
        newMessage.filename = info.filename || null;
        newMessage.mediaUrl = `/api/media/${info.id}`;
        try { await downloadMediaFromMeta(info.id, waToken); } catch {}
      } else {
        newMessage.type = 'text';
        newMessage.text = `[Tipo no soportado: ${msg.type}]`;
      }

      await dbSaveMessage(newMessage, waId, tenantId);
      console.log(`📩 Mensaje de ${contactName} (${waId}): ${newMessage.type}`);

      const broadcastData = { type:'new_message', waId, name:contactName, message:newMessage };
      if (tenantId) broadcastToTenant(tenantId, broadcastData);
      else broadcastAll(broadcastData);
    }
  } catch (err) {
    console.error('Error procesando webhook WhatsApp:', err);
  }
});

// ══════════════════════════════════════════════════════════════
// API — Tenants: registro, login, perfil
// ══════════════════════════════════════════════════════════════

app.post('/api/tenant/register', async (req, res) => {
  const { businessName, fullName, email, password, country, whatsappNumber, plan } = req.body;
  if (!businessName || !email || !password) {
    return res.status(400).json({ error: 'Faltan campos obligatorios', field: 'businessName' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Correo electrónico inválido', field: 'email' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres', field: 'password' });
  }
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(`
      INSERT INTO tenants (business_name, full_name, email, password_hash, plan, country, whatsapp_number)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id, business_name, full_name, email, plan, country, created_at
    `, [businessName, fullName || null, email, hash, plan || 'basic', country || null, whatsappNumber || null]);
    const tenant = rows[0];
    const token  = jwt.sign({ tenantId: tenant.id, email: tenant.email }, JWT_SECRET, { expiresIn: '30d' });
    if (process.env.RESEND_API_KEY) {
      sendWelcomeEmail(tenant.email, tenant.business_name).catch(err =>
        console.error('[EMAIL] Bienvenida no enviada:', err.message)
      );
    }
    res.json({
      success: true,
      token,
      tenant: { id: tenant.id, businessName: tenant.business_name, fullName: tenant.full_name, email: tenant.email, plan: tenant.plan, country: tenant.country },
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Este correo ya está registrado', field: 'email' });
    res.status(500).json({ error: 'Error al registrar', details: err.message });
  }
});

app.post('/api/tenant/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Completa todos los campos' });
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });

  try {
    const { rows } = await pool.query('SELECT * FROM tenants WHERE email = $1', [email]);
    const tenant = rows[0];
    if (!tenant) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    if (!tenant.active) return res.status(403).json({ error: 'Tu cuenta ha sido suspendida. Contacta soporte.' });
    const valid = await bcrypt.compare(password, tenant.password_hash);
    if (!valid)  return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    if (tenant.expires_at && new Date(tenant.expires_at) < new Date()) {
      return res.status(403).json({ error: 'demo_expired', message: 'Tu período de demo ha finalizado. Escríbenos a info@magicdesignllc.com para activar tu cuenta.' });
    }
    const token = jwt.sign({ tenantId: tenant.id, email: tenant.email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true,
      token,
      tenant: { id: tenant.id, businessName: tenant.business_name, fullName: tenant.full_name, email: tenant.email, plan: tenant.plan, country: tenant.country },
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al iniciar sesión', details: err.message });
  }
});

// ── Email via Resend ──
async function sendEmail({ to, subject, html }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend error: ${err}`);
  }
  console.log(`[EMAIL] Enviado a ${to}: ${subject}`);
}

async function sendResetEmail(to, resetUrl) {
  await sendEmail({
    to,
    subject: 'Restablecer contraseña — CENTRAL',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0d0d14;color:#e8e8f0;border-radius:16px;">
        <h2 style="color:#a78bfa;margin-bottom:8px;">Restablecer contraseña</h2>
        <p style="color:#9999bb;margin-bottom:24px;">Haz clic en el botón para crear una nueva contraseña. El enlace expira en 1 hora.</p>
        <a href="${resetUrl}" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#7c5cfc,#a78bfa);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;">Restablecer contraseña</a>
        <p style="color:#5555aa;font-size:12px;margin-top:24px;">Si no solicitaste esto, ignora este correo.</p>
      </div>`,
  });
}

async function sendWelcomeEmail(to, businessName) {
  await sendEmail({
    to,
    subject: '¡Bienvenido a CENTRAL! 🎉',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0d0d14;color:#e8e8f0;border-radius:16px;">
        <h2 style="color:#a78bfa;margin-bottom:8px;">¡Hola, ${businessName}!</h2>
        <p style="color:#9999bb;margin-bottom:16px;">Tu cuenta en CENTRAL está lista. Conecta tu WhatsApp e Instagram y empieza a gestionar tus pedidos desde un solo lugar.</p>
        <a href="${APP_URL}" style="display:inline-block;padding:12px 28px;background:linear-gradient(135deg,#7c5cfc,#a78bfa);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;">Abrir CENTRAL</a>
        <p style="color:#5555aa;font-size:12px;margin-top:24px;">¿Necesitas ayuda? Responde este correo o escríbenos.</p>
      </div>`,
  });
}

// ── Forgot password ──
app.post('/api/tenant/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Correo requerido' });
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const { rows } = await pool.query('SELECT id FROM tenants WHERE email = $1 AND active = true', [email]);
    // Siempre responder OK para no revelar si el correo existe
    if (rows[0]) {
      const token   = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
      await pool.query('UPDATE tenants SET reset_token=$1, reset_token_expires=$2 WHERE id=$3', [token, expires, rows[0].id]);
      const resetUrl = `${process.env.APP_URL || 'https://central-backend-production.up.railway.app'}/reset-password.html?token=${token}`;
      if (process.env.RESEND_API_KEY) {
        await sendResetEmail(email, resetUrl);
      } else {
        console.log(`[RESET] Token para ${email}: ${resetUrl}`);
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('forgot-password error:', err);
    res.status(500).json({ error: 'Error al procesar solicitud' });
  }
});

// ── Reset password ──
app.post('/api/tenant/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Datos incompletos' });
  if (password.length < 8)  return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const { rows } = await pool.query(
      'SELECT id FROM tenants WHERE reset_token=$1 AND reset_token_expires > NOW() AND active=true',
      [token]
    );
    if (!rows[0]) return res.status(400).json({ error: 'El enlace no es válido o ha expirado' });
    const hash = await bcrypt.hash(password, 12);
    await pool.query('UPDATE tenants SET password_hash=$1, reset_token=NULL, reset_token_expires=NULL WHERE id=$2', [hash, rows[0].id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al restablecer contraseña' });
  }
});

app.get('/api/tenant/profile', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, business_name, full_name, email, plan, country, whatsapp_number, whatsapp_phone_number_id, instagram_account_id, created_at FROM tenants WHERE id = $1',
      [req.tenant.tenantId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tenant no encontrado' });
    const t = rows[0];
    const phoneId = t.whatsapp_phone_number_id;
    res.json({
      id:                      t.id,
      business_name:           t.business_name,
      full_name:               t.full_name,
      email:                   t.email,
      plan:                    t.plan,
      country:                 t.country,
      whatsapp_number:         t.whatsapp_number,
      created_at:              t.created_at,
      instagram_account_id:    t.instagram_account_id,
      whatsapp_connected:      !!phoneId,
      whatsapp_phone_number_id: phoneId
        ? '*'.repeat(Math.max(0, phoneId.length - 4)) + phoneId.slice(-4)
        : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tenant/profile', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const allowed = ['business_name', 'full_name', 'email', 'country', 'whatsapp_number'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(req.body || {})) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = $${i++}`);
    values.push(val);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
  values.push(req.tenant.tenantId);
  try {
    const { rows } = await pool.query(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i} RETURNING business_name, full_name, email, country, whatsapp_number`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tenant no encontrado' });
    res.json({ success: true, tenant: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese correo ya está en uso por otra cuenta' });
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/tenant/whatsapp', requireAuth, async (req, res) => {
  const { whatsapp_phone_number_id, whatsapp_token } = req.body;
  if (!whatsapp_phone_number_id || !whatsapp_token) {
    return res.status(400).json({ error: 'Phone Number ID y Token son obligatorios' });
  }
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    await pool.query(
      'UPDATE tenants SET whatsapp_phone_number_id = $1, whatsapp_token = $2 WHERE id = $3',
      [whatsapp_phone_number_id.trim(), whatsapp_token.trim(), req.tenant.tenantId]
    );
    res.json({ success: true, message: 'WhatsApp conectado correctamente' });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar las credenciales' });
  }
});

app.get('/api/tenant/test-whatsapp', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ success: false, error: 'Base de datos no disponible' });
  try {
    const { rows } = await pool.query(
      'SELECT whatsapp_phone_number_id, whatsapp_token FROM tenants WHERE id = $1',
      [req.tenant.tenantId]
    );
    const t = rows[0];
    if (!t?.whatsapp_phone_number_id || !t?.whatsapp_token) {
      return res.json({ success: false, error: 'No hay credenciales de WhatsApp guardadas' });
    }
    const metaRes = await axios.get(
      `${GRAPH_BASE}/${t.whatsapp_phone_number_id}`,
      { headers: { Authorization: `Bearer ${t.whatsapp_token}` } }
    );
    const d = metaRes.data;
    res.json({
      success:       true,
      phone_number:  d.display_phone_number || d.phone_number || '—',
      verified_name: d.verified_name || d.name || '—',
    });
  } catch (err) {
    const msg = err.response?.data?.error?.message || 'Credenciales inválidas o token expirado';
    res.json({ success: false, error: msg });
  }
});

// ══════════════════════════════════════════════════════════════
// API — Conversaciones
// ══════════════════════════════════════════════════════════════

app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const convos = await dbGetConversations(req.tenant.tenantId);
    res.json(convos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/conversations/:waId', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.wa_id, c.name, c.platform, c.ig_sender_id, c.last_message_at,
        COALESCE(
          json_agg(json_build_object(
            'id', m.id, 'role', m.role, 'type', m.type, 'text', m.text,
            'mediaId', m.media_id, 'mimeType', m.mime_type, 'mediaUrl', m.media_url,
            'caption', m.caption, 'filename', m.filename, 'orderType', m.order_type,
            'time', to_char(m.time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
          ) ORDER BY m.time) FILTER (WHERE m.id IS NOT NULL), '[]'::json
        ) AS messages
      FROM conversations c
      LEFT JOIN messages m ON m.wa_id = c.wa_id AND m.tenant_id = c.tenant_id
      WHERE c.wa_id = $1 AND c.tenant_id = $2
      GROUP BY c.wa_id, c.tenant_id
    `, [req.params.waId, req.tenant.tenantId]);

    if (!rows[0]) return res.status(404).json({ error: 'Conversación no encontrada' });
    res.json({ waId: rows[0].wa_id, name: rows[0].name, platform: rows[0].platform,
               igSenderId: rows[0].ig_sender_id, messages: rows[0].messages || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// API — Pedidos
// ══════════════════════════════════════════════════════════════

app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const orders = await dbGetOrders(req.tenant.tenantId);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/orders', requireAuth, async (req, res) => {
  if (!req.body || !req.body.clientName) {
    return res.status(400).json({ error: 'Falta clientName' });
  }
  try {
    const order = await dbCreateOrder(req.tenant.tenantId, req.body);
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/orders/:id', requireAuth, async (req, res) => {
  try {
    const order = await dbUpdateOrder(req.tenant.tenantId, req.params.id, req.body || {});
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// API — Reports
// ══════════════════════════════════════════════════════════════

app.get('/api/reports', requireAuth, async (req, res) => {
  const tenantId = req.tenant.tenantId;
  const { period = 'hoy', from, to } = req.query;
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  if ((from && !ISO_DATE.test(from)) || (to && !ISO_DATE.test(to))) {
    return res.status(400).json({ error: 'Fechas inválidas (formato YYYY-MM-DD)' });
  }

  // Build time window
  let startExpr, endExpr, groupBy, labelFn, barCount;
  const now = new Date();

  if (period === 'hoy') {
    const todayStr = now.toISOString().slice(0, 10);
    startExpr = `'${todayStr} 00:00:00'`;
    endExpr   = `'${todayStr} 23:59:59'`;
    groupBy   = `EXTRACT(HOUR FROM created_at)`;
    barCount  = 24;
  } else if (period === '7dias') {
    const d = new Date(now); d.setDate(d.getDate() - 6);
    startExpr = `'${d.toISOString().slice(0,10)} 00:00:00'`;
    endExpr   = `NOW()`;
    groupBy   = `DATE(created_at)`;
    barCount  = 7;
  } else if (period === 'mes') {
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
    startExpr = `'${firstDay} 00:00:00'`;
    endExpr   = `NOW()`;
    groupBy   = `DATE(created_at)`;
    barCount  = 31;
  } else if (period === 'año') {
    startExpr = `'${now.getFullYear()}-01-01 00:00:00'`;
    endExpr   = `NOW()`;
    groupBy   = `EXTRACT(MONTH FROM created_at)`;
    barCount  = 12;
  } else if (period === 'personalizado' && from && to) {
    startExpr = `'${from} 00:00:00'`;
    endExpr   = `'${to} 23:59:59'`;
    groupBy   = `DATE(created_at)`;
    barCount  = 31;
  } else {
    return res.status(400).json({ error: 'period inválido' });
  }

  const timeFilter = `created_at BETWEEN ${startExpr} AND ${endExpr}`;

  try {
    // KPIs
    const { rows: kpi } = await pool.query(`
      SELECT
        COALESCE(SUM(total_price), 0)::float                                        AS ventas,
        COUNT(*)::int                                                                AS pedidos,
        COUNT(*) FILTER (WHERE delivery_status = 'delivered')::int                  AS entregados,
        COUNT(*) FILTER (WHERE delivery_status = 'to_deliver')::int                 AS pendientes,
        COUNT(*) FILTER (WHERE delivery_status = 'not_delivered')::int              AS cancelados,
        COUNT(*) FILTER (WHERE delivery_method_label ILIKE '%Motorizado%'
                            OR delivery_method_label ILIKE '%Delivery%')::int        AS delivery,
        COUNT(*) FILTER (WHERE delivery_method_label ILIKE '%Encomienda%')::int     AS encomiendas,
        COUNT(*) FILTER (WHERE platform = 'wa')::int                                AS count_wa,
        COUNT(*) FILTER (WHERE platform = 'ig')::int                                AS count_ig
      FROM orders
      WHERE tenant_id = $1 AND ${timeFilter}
    `, [tenantId]);

    const k = kpi[0];
    const total = k.pedidos || 1;
    const waCount = k.count_wa || 0;
    const igCount = k.count_ig || 0;
    const canalTotal = waCount + igCount || 1;

    // New clients in period
    const { rows: nc } = await pool.query(`
      SELECT COUNT(*)::int AS cnt FROM clients
      WHERE tenant_id = $1 AND created_at BETWEEN ${startExpr} AND ${endExpr}
    `, [tenantId]);

    // Top products
    const { rows: tp } = await pool.query(`
      SELECT oi.emoji || ' ' || oi.name AS name,
             SUM(oi.qty)::int            AS qty,
             SUM(oi.line_price)::float   AS total
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE o.tenant_id = $1 AND ${timeFilter.replace('created_at', 'o.created_at')}
      GROUP BY oi.emoji, oi.name
      ORDER BY qty DESC
      LIMIT 6
    `, [tenantId]);

    // Time-series bars
    const { rows: ts } = await pool.query(`
      SELECT ${groupBy} AS bucket,
             COALESCE(SUM(total_price), 0)::float AS amount
      FROM orders
      WHERE tenant_id = $1 AND ${timeFilter}
      GROUP BY bucket
      ORDER BY bucket
    `, [tenantId]);

    // Build bars arrays
    let bars = [], barLabels = [];
    if (period === 'hoy') {
      for (let h = 0; h < 24; h++) {
        const row = ts.find(r => parseInt(r.bucket) === h);
        if (row || h <= now.getHours()) {
          bars.push(row ? Math.round(row.amount) : 0);
          barLabels.push(h + ':00');
        }
      }
    } else if (period === 'año') {
      const months = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
      for (let m = 1; m <= 12; m++) {
        const row = ts.find(r => parseInt(r.bucket) === m);
        bars.push(row ? Math.round(row.amount) : 0);
        barLabels.push(months[m - 1]);
      }
    } else {
      ts.forEach(r => {
        bars.push(Math.round(r.amount));
        const d = new Date(r.bucket);
        barLabels.push(period === '7dias'
          ? ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'][d.getDay()]
          : String(d.getDate()));
      });
    }
    if (bars.length === 0) { bars = [0]; barLabels = ['—']; }

    res.json({
      ventas: Math.round(k.ventas * 100) / 100,
      pedidos: k.pedidos,
      entregados: k.entregados,
      pendientes: k.pendientes,
      cancelados: k.cancelados,
      delivery: k.delivery,
      encomiendas: k.encomiendas,
      newClients: nc[0].cnt,
      topProducts: tp.map(p => [p.name, p.qty, '$' + p.total.toFixed(2)]),
      bars,
      barLabels,
      canal: {
        wa: Math.round(waCount / canalTotal * 100),
        ig: Math.round(igCount / canalTotal * 100),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// API — Clientes
// ══════════════════════════════════════════════════════════════

app.get('/api/clients', requireAuth, async (req, res) => {
  try {
    const clients = await dbGetClients(req.tenant.tenantId);
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/clients', requireAuth, async (req, res) => {
  if (!req.body || !req.body.name) {
    return res.status(400).json({ error: 'Falta name' });
  }
  try {
    const client = await dbUpsertClient(req.tenant.tenantId, req.body);
    res.json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const client = await dbUpsertClient(req.tenant.tenantId, { ...req.body, id: req.params.id });
    if (!client) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json(client);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/clients/:id', requireAuth, async (req, res) => {
  try {
    const ok = await dbDeleteClient(req.tenant.tenantId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Cliente no encontrado' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// API — Catálogo
// ══════════════════════════════════════════════════════════════

app.get('/api/catalog', requireAuth, async (req, res) => {
  try {
    const catalog = await dbGetCatalog(req.tenant.tenantId);
    res.json(catalog);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/catalog', requireAuth, async (req, res) => {
  if (!req.body || !req.body.name) {
    return res.status(400).json({ error: 'Falta name' });
  }
  try {
    const product = await dbUpsertProduct(req.tenant.tenantId, req.body);
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/catalog/:id', requireAuth, async (req, res) => {
  try {
    const product = await dbUpsertProduct(req.tenant.tenantId, { ...req.body, id: req.params.id });
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/catalog/:id', requireAuth, async (req, res) => {
  try {
    const ok = await dbDeleteProduct(req.tenant.tenantId, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// API — Media
// ══════════════════════════════════════════════════════════════

app.get('/api/media/:mediaId', requireAuth, async (req, res) => {
  const { mediaId } = req.params;
  try {
    let cached = mediaCache[mediaId];
    if (!cached) {
      const creds = await getTenantCredentials(req.tenant.tenantId);
      cached = await downloadMediaFromMeta(mediaId, creds.whatsapp_token);
    }
    res.set('Content-Type', cached.mimeType);
    res.send(cached.buffer);
  } catch (err) {
    res.status(404).json({ error: 'Archivo no encontrado o expirado' });
  }
});

// ══════════════════════════════════════════════════════════════
// API — Enviar mensaje de texto (WhatsApp)
// ══════════════════════════════════════════════════════════════

// En cuentas demo los envíos se guardan y se ven en el chat, pero nunca salen a Meta
function simulateIfDemo(kind) {
  return async (req, res, next) => {
    if (!req.tenant?.isDemo) return next();
    const b = req.body || {};
    const tenantId = req.tenant.tenantId;
    const platform = kind === 'ig' ? 'ig' : 'wa';
    const convoKey = kind === 'ig' ? (b.igId ? `ig_${b.igId}` : null) : b.waId;
    if (!convoKey) return res.status(400).json({ error: 'Falta el destinatario' });
    const text = kind === 'ticket' ? (b.caption || '🧾 Resguardo de compra')
               : kind === 'media'  ? (b.caption || '📎 Archivo adjunto')
               : b.text;
    if (!text) return res.status(400).json({ error: 'Falta el texto' });
    try {
      await dbGetOrCreateConvo(convoKey, null, tenantId, platform, kind === 'ig' ? b.igId : null);
      const sentMessage = { id: 'demo_' + crypto.randomUUID(), role: 'out', type: 'text', text, time: new Date().toISOString() };
      await dbSaveMessage(sentMessage, convoKey, tenantId);
      broadcastToTenant(tenantId, { type: 'message_sent', waId: convoKey, platform, message: sentMessage });
      res.json({ success: true, demo: true, message: sentMessage });
    } catch (err) {
      res.status(500).json({ error: 'Error al enviar' });
    }
  };
}

app.post('/api/send', requireAuth, simulateIfDemo('text'), async (req, res) => {
  const { waId, text } = req.body;
  if (!waId || !text) return res.status(400).json({ error: 'Faltan waId o text' });

  try {
    const creds = await getTenantCredentials(req.tenant.tenantId);
    if (!creds.whatsapp_phone_number_id || !creds.whatsapp_token) {
      return res.status(500).json({ error: 'WhatsApp no configurado para este tenant' });
    }

    const response = await axios.post(
      `${GRAPH_BASE}/${creds.whatsapp_phone_number_id}/messages`,
      { messaging_product:'whatsapp', to:waId, type:'text', text:{ body:text } },
      { headers: { Authorization:`Bearer ${creds.whatsapp_token}`, 'Content-Type':'application/json' } }
    );

    const sentMessage = {
      id:   response.data.messages?.[0]?.id || 'local_' + Date.now(),
      role: 'out', type: 'text', text, time: new Date().toISOString(),
    };
    await dbGetOrCreateConvo(waId, null, req.tenant.tenantId, 'wa');
    await dbSaveMessage(sentMessage, waId, req.tenant.tenantId);
    broadcastToTenant(req.tenant.tenantId, { type:'message_sent', waId, message:sentMessage });
    res.json({ success: true, message: sentMessage });
  } catch (err) {
    console.error('Error enviando mensaje:', err.response?.data || err.message);
    res.status(500).json({ error:'Error al enviar', details: err.response?.data || err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// API — Enviar archivo adjunto (WhatsApp)
// ══════════════════════════════════════════════════════════════

app.post('/api/send-media', requireAuth, upload.single('file'), simulateIfDemo('media'), async (req, res) => {
  const { waId, caption } = req.body;
  const file = req.file;
  if (!waId || !file) return res.status(400).json({ error: 'Faltan waId o file' });

  try {
    const creds  = await getTenantCredentials(req.tenant.tenantId);
    if (!creds.whatsapp_phone_number_id || !creds.whatsapp_token) {
      return res.status(500).json({ error: 'WhatsApp no configurado' });
    }
    const mediaId = await uploadMediaToMeta(file.buffer, file.mimetype, file.originalname, creds.whatsapp_phone_number_id, creds.whatsapp_token);
    const waType  = whatsappTypeFromMime(file.mimetype);
    const result  = await sendMediaMessage(waId, mediaId, waType, caption, file.originalname, creds.whatsapp_phone_number_id, creds.whatsapp_token);

    mediaCache[mediaId] = { buffer: file.buffer, mimeType: file.mimetype, size: file.size };

    const sentMessage = {
      id: result.messages?.[0]?.id || 'local_' + Date.now(),
      role:'out', type:waType, mediaId, mimeType:file.mimetype,
      filename:file.originalname, caption:caption||'', mediaUrl:`/api/media/${mediaId}`,
      time: new Date().toISOString(),
    };
    await dbGetOrCreateConvo(waId, null, req.tenant.tenantId, 'wa');
    await dbSaveMessage(sentMessage, waId, req.tenant.tenantId);
    broadcastToTenant(req.tenant.tenantId, { type:'message_sent', waId, message:sentMessage });
    res.json({ success: true, message: sentMessage });
  } catch (err) {
    console.error('Error enviando archivo:', err.response?.data || err.message);
    res.status(500).json({ error:'Error al enviar archivo', details: err.response?.data || err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// API — Enviar ticket como imagen PNG (WhatsApp)
// ══════════════════════════════════════════════════════════════

app.post('/api/send-ticket', requireAuth, simulateIfDemo('ticket'), async (req, res) => {
  const { waId, ticketHtml, caption, orderType } = req.body;
  if (!waId || !ticketHtml) return res.status(400).json({ error: 'Faltan waId o ticketHtml' });

  try {
    const creds = await getTenantCredentials(req.tenant.tenantId);
    if (!creds.whatsapp_phone_number_id || !creds.whatsapp_token) {
      return res.status(500).json({ error: 'WhatsApp no configurado' });
    }

    const imageBuffer = await renderHtmlToImage(ticketHtml);
    const mediaId     = await uploadMediaToMeta(imageBuffer, 'image/png', `ticket_${Date.now()}.png`, creds.whatsapp_phone_number_id, creds.whatsapp_token);
    const result      = await sendMediaMessage(waId, mediaId, 'image', caption||'', null, creds.whatsapp_phone_number_id, creds.whatsapp_token);

    mediaCache[mediaId] = { buffer: imageBuffer, mimeType:'image/png', size: imageBuffer.length };

    const sentMessage = {
      id: result.messages?.[0]?.id || 'local_' + Date.now(),
      role:'out', type:'image', mediaId, mimeType:'image/png',
      caption:caption||'', mediaUrl:`/api/media/${mediaId}`, orderType:orderType||null,
      time: new Date().toISOString(),
    };
    await dbGetOrCreateConvo(waId, null, req.tenant.tenantId, 'wa');
    await dbSaveMessage(sentMessage, waId, req.tenant.tenantId);
    broadcastToTenant(req.tenant.tenantId, { type:'message_sent', waId, message:sentMessage });
    console.log(`🧾 Ticket (${orderType||'sin tipo'}) enviado a ${waId}`);
    res.json({ success:true, message:sentMessage, mediaId });
  } catch (err) {
    console.error('Error enviando ticket:', err.response?.data || err.message);
    res.status(500).json({ error:'Error al enviar ticket', details: err.response?.data || err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// API — Enviar mensaje de texto por Instagram
// ══════════════════════════════════════════════════════════════

app.post('/api/send-instagram', requireAuth, simulateIfDemo('ig'), async (req, res) => {
  const { igId, text } = req.body;
  if (!igId || !text) return res.status(400).json({ error: 'Faltan igId o text' });

  try {
    const creds = await getTenantCredentials(req.tenant.tenantId);
    if (!creds.instagram_access_token) return res.status(500).json({ error: 'Instagram no configurado' });

    const response = await axios.post(
      `https://graph.instagram.com/${GRAPH_API_VERSION}/me/messages`,
      { recipient:{ id: igId }, message:{ text } },
      { headers: { Authorization:`Bearer ${creds.instagram_access_token}`, 'Content-Type':'application/json' } }
    );

    const convoKey = `ig_${igId}`;
    await dbGetOrCreateConvo(convoKey, igId, req.tenant.tenantId, 'ig', igId);
    const sentMessage = {
      id:   response.data.message_id || 'ig_out_' + Date.now(),
      role: 'out', type: 'text', text, time: new Date().toISOString(),
    };
    await dbSaveMessage(sentMessage, convoKey, req.tenant.tenantId);
    broadcastToTenant(req.tenant.tenantId, { type:'message_sent', waId:convoKey, platform:'ig', message:sentMessage });
    res.json({ success:true, message:sentMessage });
  } catch (err) {
    console.error('Error enviando Instagram DM:', err.response?.data || err.message);
    res.status(500).json({ error:'Error al enviar por Instagram', details: err.response?.data || err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// Deauth/delete callbacks requeridos por Meta
// ══════════════════════════════════════════════════════════════
app.get('/auth/instagram/deauth',  (req, res) => res.sendStatus(200));
app.post('/auth/instagram/deauth', (req, res) => res.sendStatus(200));
app.get('/auth/instagram/delete',  (req, res) => res.sendStatus(200));
app.post('/auth/instagram/delete', (req, res) => res.sendStatus(200));

// ══════════════════════════════════════════════════════════════
// Servir archivos estáticos — SPA excluido del acceso público
// El SPA (central-mvp-v63) solo se sirve via /app con JWT válido
const path = require('path');
const fs   = require('fs');
const SPA_FILE = path.join(__dirname, 'central-mvp-v63 (1) - copia.html');

// Lista blanca: solo páginas públicas e imágenes. Nunca .js, .json, .toml ni el SPA.
const PUBLIC_STATIC = /^\/[\w.-]+\.(html|png|jpe?g|svg|ico|webp|css)$/i;
app.use((req, res, next) => {
  let p;
  try { p = decodeURIComponent(req.path); } catch { return res.status(400).end(); }
  if (/^\/central-mvp/i.test(p)) {
    // URLs viejas del SPA (p.ej. retorno de Stripe) pasan por /app conservando la query
    const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
    return res.redirect('/app' + qs);
  }
  if (req.method === 'GET' && /\.[a-z0-9]+$/i.test(p) && !PUBLIC_STATIC.test(p)) return res.status(404).end();
  next();
});
app.use(express.static(__dirname, { dotfiles: 'deny', index: false }));

// Sin token en la URL: página mínima que toma el JWT de localStorage y vuelve con él
const APP_BOOTSTRAP = `<!DOCTYPE html><meta charset="utf-8"><title>CENTRAL</title><script>
var t=null;try{t=localStorage.getItem('central_jwt')}catch(e){}
var q=new URLSearchParams(location.search);
if(t){q.set('token',t);location.replace('/app?'+q.toString())}else{location.replace('/central-registro.html')}
</script>`;

const APP_LOGOUT = `<!DOCTYPE html><meta charset="utf-8"><script>try{localStorage.removeItem('central_jwt')}catch(e){}location.replace('/central-registro.html')</script>`;

app.get('/app', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.type('html').send(APP_BOOTSTRAP);

  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch { return res.type('html').send(APP_LOGOUT); }

  let tenant = null;
  if (dbReady && decoded.tenantId) {
    try {
      const { rows } = await pool.query(
        'SELECT active, expires_at, is_demo, business_name FROM tenants WHERE id = $1',
        [decoded.tenantId]
      );
      tenant = rows[0];
    } catch { return res.status(503).send('Servicio no disponible, intenta en un momento'); }
    if (!tenant || !tenant.active) return res.type('html').send(APP_LOGOUT);
    if (tenant.expires_at && new Date(tenant.expires_at) < new Date()) {
      return res.type('html').send(buildExpiredPage(tenant.business_name));
    }
  }

  let html;
  try { html = fs.readFileSync(SPA_FILE, 'utf8'); }
  catch { return res.status(500).send('Error cargando la app'); }

  let inject = `<script>(function(){var u=new URL(location.href);if(u.searchParams.has('token')){try{localStorage.setItem('central_jwt',u.searchParams.get('token'))}catch(e){}u.searchParams.delete('token');history.replaceState(null,'',u.pathname+(u.search||''))}})();</script>`;
  if (tenant?.is_demo && tenant.expires_at) {
    const daysLeft = Math.max(0, Math.ceil((new Date(tenant.expires_at) - new Date()) / 86400000));
    inject += `<script>window.__DEMO_MODE__=true;window.__DEMO_DAYS_LEFT__=${daysLeft};window.__DEMO_EXPIRES__=${JSON.stringify(new Date(tenant.expires_at).toISOString())};</script>`;
  }
  html = html.replace('</head>', inject + '\n</head>');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(html);
});

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function buildExpiredPage(businessName) {
  businessName = escHtml(businessName);
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Demo expirado — CENTRAL</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#0d0d14;color:#e8e8f0;font-family:-apple-system,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}.card{background:#15151f;border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:48px 40px;max-width:440px;width:100%;text-align:center}.icon{font-size:48px;margin-bottom:20px}.title{font-size:24px;font-weight:800;margin-bottom:10px}.sub{color:#9999bb;font-size:15px;line-height:1.6;margin-bottom:32px}.btn{display:inline-block;padding:13px 28px;background:linear-gradient(135deg,#7c5cfc,#a78bfa);color:#fff;border-radius:10px;text-decoration:none;font-weight:700;font-size:15px}</style></head>
<body><div class="card"><div class="icon">⏰</div><div class="title">Tu demo ha expirado</div><div class="sub">El período de prueba de <strong>${businessName || 'tu negocio'}</strong> ha concluido.<br>Contacta a Magic Design LLC para activar tu cuenta completa.</div><a href="mailto:info@magicdesignllc.com" class="btn">Contactar ahora →</a></div></body></html>`;
}

// ══════════════════════════════════════════════════════════════
// Health check & rutas raíz
// ══════════════════════════════════════════════════════════════
app.get('/', (req, res) => res.redirect('/central-registro.html'));
app.get('/health', (req, res) => res.json({ status:'ok', db:dbReady, timestamp:new Date().toISOString() }));
app.get('/status', (req, res) => res.json({
  status:    'ok',
  service:   'CENTRAL Backend',
  version:   '5.0 — Multi-tenant + PostgreSQL + WhatsApp + Instagram',
  db_ready:  dbReady,
  whatsapp_configured:  !!DEFAULT_PHONE_ID,
  instagram_configured: !!DEFAULT_IG_TOKEN,
}));

app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Política de Privacidad — CENTRAL</title>
  <style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6;}h1{color:#333;}h2{color:#555;margin-top:30px;}</style></head>
  <body>
  <h1>Política de Privacidad de CENTRAL</h1>
  <p><strong>Última actualización:</strong> ${new Date().toLocaleDateString('es-ES')}</p>
  <h2>1. Información que recopilamos</h2>
  <p>CENTRAL recopila mensajes de WhatsApp e Instagram Business exclusivamente para facilitar la gestión de comunicaciones comerciales.</p>
  <h2>2. Uso de la información</h2>
  <p>La información se usa únicamente dentro de la plataforma CENTRAL. No se comparte con terceros.</p>
  <h2>3. Almacenamiento</h2>
  <p>Los datos se almacenan de forma segura en servidores protegidos. Los usuarios pueden solicitar la eliminación en cualquier momento.</p>
  <h2>4. Contacto</h2>
  <p><a href="mailto:vyralvideos.creators@gmail.com">vyralvideos.creators@gmail.com</a></p>
  </body></html>`);
});

// ══════════════════════════════════════════════════════════════
// BILLING — Stripe
// ══════════════════════════════════════════════════════════════

// Webhook necesita raw body — registrar ANTES de express.json()
// (express.json ya está arriba, así que usamos express.raw solo para este path)
app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe no configurado' });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('⚠️  Stripe webhook firma inválida:', err.message);
    return res.status(400).send('Webhook signature invalid');
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session    = event.data.object;
      const tenantId   = session.metadata?.tenantId;
      const plan       = session.metadata?.plan;
      const customerId = session.customer;
      const subId      = session.subscription;
      if (tenantId && plan) {
        await pool.query(
          'UPDATE tenants SET plan=$1, stripe_customer_id=$2, stripe_subscription_id=$3, billing_status=$4 WHERE id=$5',
          [plan, customerId, subId, 'active', tenantId]
        );
        console.log(`✅ Stripe: tenant ${tenantId} activó plan ${plan}`);
      }
    }

    if (event.type === 'invoice.payment_succeeded') {
      const invoice = event.data.object;
      const subId   = invoice.subscription;
      if (subId) {
        const periodEnd = new Date(invoice.lines?.data?.[0]?.period?.end * 1000 || Date.now());
        await pool.query(
          'UPDATE tenants SET billing_status=$1, plan_expires_at=$2 WHERE stripe_subscription_id=$3',
          ['active', periodEnd, subId]
        );
        console.log(`✅ Stripe: pago exitoso para sub ${subId}`);
      }
    }

    if (event.type === 'invoice.payment_failed') {
      const invoice = event.data.object;
      const subId   = invoice.subscription;
      if (subId) {
        await pool.query(
          'UPDATE tenants SET billing_status=$1 WHERE stripe_subscription_id=$2',
          ['past_due', subId]
        );
        console.warn(`⚠️  Stripe: pago fallido para sub ${subId}`);
      }
    }

    if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      // Si el usuario reactivó desde el portal, sincronizar estado
      const billing_status = sub.status === 'active' ? 'active' : sub.status;
      const plan_map = {}; // plan se determina por metadata o price, no lo cambiamos aquí
      if (sub.cancel_at_period_end) {
        // Cancelación programada — sigue activo hasta fin de período
        await pool.query(
          'UPDATE tenants SET billing_status=$1 WHERE stripe_subscription_id=$2',
          ['cancelled', sub.id]
        );
      } else if (sub.status === 'active') {
        await pool.query(
          'UPDATE tenants SET billing_status=$1 WHERE stripe_subscription_id=$2',
          ['active', sub.id]
        );
      }
    }

    if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      await pool.query(
        'UPDATE tenants SET plan=$1, billing_status=$2, stripe_subscription_id=$3 WHERE stripe_subscription_id=$4',
        ['basic', 'cancelled', null, sub.id]
      );
      console.log(`⚠️  Stripe: suscripción ${sub.id} cancelada — tenant bajado a basic`);
    }
  } catch (err) {
    console.error('Error procesando evento Stripe:', err.message);
  }

  res.json({ received: true });
});

app.post('/api/billing/create-checkout', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe no configurado' });
  const { plan } = req.body;
  if (!['pro','business'].includes(plan)) return res.status(400).json({ error: 'Plan inválido' });
  const priceId = plan === 'pro' ? STRIPE_PRICE_PRO : STRIPE_PRICE_BUSINESS;
  if (!priceId) return res.status(503).json({ error: `STRIPE_PRICE_${plan.toUpperCase()} no configurado` });

  try {
    const { rows } = await pool.query('SELECT * FROM tenants WHERE id=$1', [req.tenant.tenantId]);
    const tenant   = rows[0];
    if (!tenant) return res.status(404).json({ error: 'Tenant no encontrado' });

    let customerId = tenant.stripe_customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: tenant.email, name: tenant.business_name, metadata: { tenantId: tenant.id } });
      customerId = customer.id;
      await pool.query('UPDATE tenants SET stripe_customer_id=$1 WHERE id=$2', [customerId, tenant.id]);
    }

    const session = await stripe.checkout.sessions.create({
      customer:            customerId,
      payment_method_types: ['card'],
      mode:                'subscription',
      line_items:          [{ price: priceId, quantity: 1 }],
      success_url:         `${APP_URL.replace(/\/$/, '')}/app?payment=success`,
      cancel_url:          `${APP_URL.replace(/\/$/, '')}/app?payment=cancelled`,
      metadata:            { tenantId: tenant.id, plan },
    });

    res.json({ checkoutUrl: session.url });
  } catch (err) {
    console.error('❌ Stripe checkout error:', err.message, err.type, err.code);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/billing/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT plan, billing_status, plan_expires_at, stripe_subscription_id FROM tenants WHERE id=$1',
      [req.tenant.tenantId]
    );
    const t = rows[0];
    if (!t) return res.status(404).json({ error: 'Tenant no encontrado' });

    let nextBillingDate = null;
    if (stripe && t.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(t.stripe_subscription_id);
        nextBillingDate = new Date(sub.current_period_end * 1000).toISOString();
      } catch {}
    }

    res.json({
      plan:           t.plan,
      billingStatus:  t.billing_status || 'free',
      planExpiresAt:  t.plan_expires_at,
      nextBillingDate,
      hasSubscription: !!t.stripe_subscription_id,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/billing/cancel', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe no configurado' });
  try {
    const { rows } = await pool.query('SELECT stripe_subscription_id FROM tenants WHERE id=$1', [req.tenant.tenantId]);
    const subId = rows[0]?.stripe_subscription_id;
    if (!subId) return res.status(400).json({ error: 'No tienes una suscripción activa' });

    const sub = await stripe.subscriptions.update(subId, { cancel_at_period_end: true });
    const cancelDate = new Date(sub.current_period_end * 1000).toLocaleDateString('es-ES', { day:'2-digit', month:'long', year:'numeric' });
    // billing_status se actualiza vía webhook customer.subscription.updated, no aquí
    // para que refleje el estado real de Stripe
    res.json({ success: true, message: `Tu suscripción se cancelará el ${cancelDate}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/billing/portal', requireAuth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe no configurado' });
  try {
    const { rows } = await pool.query('SELECT stripe_customer_id FROM tenants WHERE id=$1', [req.tenant.tenantId]);
    const customerId = rows[0]?.stripe_customer_id;
    if (!customerId) return res.status(400).json({ error: 'No tienes una cuenta de facturación aún' });

    const session = await stripe.billingPortal.sessions.create({
      customer:   customerId,
      return_url: `${APP_URL}/app`,
    });
    res.json({ portalUrl: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ADMIN — middleware y endpoints de superadmin
// ══════════════════════════════════════════════════════════════

const ADMIN_EMAIL    = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  try {
    const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
    if (decoded.role !== 'superadmin') return res.status(403).json({ error: 'Acceso denegado' });
    req.admin = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    return res.status(503).json({ error: 'Panel de admin no configurado — define ADMIN_EMAIL y ADMIN_PASSWORD en Railway' });
  }
  if (!email || !password) return res.status(400).json({ error: 'Completa todos los campos' });
  if (email !== ADMIN_EMAIL || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }
  const token = jwt.sign({ role: 'superadmin', email }, JWT_SECRET, { expiresIn: '8h' });
  res.json({ success: true, token });
});

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const [totals, byPlan, newThisWeek, convos, msgs] = await Promise.all([
      pool.query(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE active) activos, COUNT(*) FILTER (WHERE NOT active) suspendidos FROM tenants`),
      pool.query(`SELECT plan, COUNT(*) count FROM tenants GROUP BY plan`),
      pool.query(`SELECT COUNT(*) count FROM tenants WHERE created_at >= NOW() - INTERVAL '7 days'`),
      pool.query(`SELECT COUNT(*) count FROM conversations`),
      pool.query(`SELECT COUNT(*) count FROM messages`),
    ]);
    const planMap = {};
    byPlan.rows.forEach(r => { planMap[r.plan] = parseInt(r.count); });
    res.json({
      total:         parseInt(totals.rows[0].total),
      activos:       parseInt(totals.rows[0].activos),
      suspendidos:   parseInt(totals.rows[0].suspendidos),
      porPlan:       planMap,
      nuevosEstaSemana: parseInt(newThisWeek.rows[0].count),
      totalConversaciones: parseInt(convos.rows[0].count),
      totalMensajes:       parseInt(msgs.rows[0].count),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/tenants', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const { search = '', plan = '', status = '', page = 1, limit = 20 } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  try {
    const conditions = [];
    const params     = [];
    if (search) { params.push(`%${search}%`); conditions.push(`(business_name ILIKE $${params.length} OR email ILIKE $${params.length})`); }
    if (plan)   { params.push(plan);   conditions.push(`plan = $${params.length}`); }
    if (status === 'active')    conditions.push(`active = true`);
    if (status === 'suspended') conditions.push(`active = false`);
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const countRes = await pool.query(`SELECT COUNT(*) count FROM tenants ${where}`, params);
    params.push(parseInt(limit), offset);
    const dataRes  = await pool.query(`
      SELECT
        t.id, t.business_name, t.full_name, t.email, t.plan, t.country,
        t.whatsapp_number, t.active, t.created_at,
        CASE WHEN t.whatsapp_phone_number_id IS NOT NULL THEN true ELSE false END AS whatsapp_connected,
        CASE WHEN t.whatsapp_phone_number_id IS NOT NULL
          THEN repeat('*', GREATEST(0, length(t.whatsapp_phone_number_id)-4)) || right(t.whatsapp_phone_number_id,4)
          ELSE NULL END AS whatsapp_phone_id_masked,
        (SELECT COUNT(*) FROM conversations c WHERE c.tenant_id = t.id) AS total_convos,
        (SELECT COUNT(*) FROM messages m WHERE m.tenant_id = t.id) AS total_msgs
      FROM tenants t
      ${where}
      ORDER BY t.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({
      total: parseInt(countRes.rows[0].count),
      page:  parseInt(page),
      limit: parseInt(limit),
      tenants: dataRes.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/tenants/:tenantId', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const { rows } = await pool.query(`
      SELECT
        t.id, t.business_name, t.full_name, t.email, t.plan, t.country,
        t.whatsapp_number, t.active, t.created_at, t.instagram_account_id,
        CASE WHEN t.whatsapp_phone_number_id IS NOT NULL THEN true ELSE false END AS whatsapp_connected,
        CASE WHEN t.whatsapp_phone_number_id IS NOT NULL
          THEN repeat('*', GREATEST(0, length(t.whatsapp_phone_number_id)-4)) || right(t.whatsapp_phone_number_id,4)
          ELSE NULL END AS whatsapp_phone_id_masked,
        (SELECT COUNT(*) FROM conversations c WHERE c.tenant_id = t.id) AS total_convos,
        (SELECT COUNT(*) FROM messages m WHERE m.tenant_id = t.id) AS total_msgs
      FROM tenants t WHERE t.id = $1
    `, [req.params.tenantId]);
    if (!rows[0]) return res.status(404).json({ error: 'Tenant no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/tenants/:tenantId/plan', requireAdmin, async (req, res) => {
  const { plan } = req.body;
  if (!['basic','pro','business'].includes(plan)) return res.status(400).json({ error: 'Plan inválido' });
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    await pool.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, req.params.tenantId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/tenants/:tenantId/status', requireAdmin, async (req, res) => {
  const { active } = req.body;
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active debe ser true o false' });
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    await pool.query('UPDATE tenants SET active = $1 WHERE id = $2', [active, req.params.tenantId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/admin/tenants/:tenantId', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const allowed = ['business_name', 'full_name', 'email', 'country', 'whatsapp_number',
    'whatsapp_phone_number_id', 'whatsapp_token', 'instagram_access_token', 'instagram_account_id'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, val] of Object.entries(req.body || {})) {
    if (!allowed.includes(key)) continue;
    sets.push(`${key} = $${i++}`);
    values.push(val);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
  values.push(req.params.tenantId);
  try {
    const { rows } = await pool.query(
      `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, business_name, full_name, email, country, whatsapp_number`,
      values
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tenant no encontrado' });
    res.json({ success: true, tenant: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese correo ya está en uso por otra cuenta' });
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/tenants/:tenantId/reset-password', requireAdmin, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    const { rowCount } = await pool.query('UPDATE tenants SET password_hash = $1 WHERE id = $2', [hash, req.params.tenantId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Tenant no encontrado' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/tenants/:tenantId', requireAdmin, async (req, res) => {
  if (req.headers['x-confirm-delete'] !== 'true') {
    return res.status(400).json({ error: 'Falta header X-Confirm-Delete: true' });
  }
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    await pool.query('DELETE FROM tenants WHERE id = $1', [req.params.tenantId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ADMIN — Demos (cuentas de prueba con datos ficticios y caducidad)
// Requieren sesión de superadmin + la clave DEMO_CREATION_KEY (header X-Demo-Key)
// ══════════════════════════════════════════════════════════════
const { seedDemoTenant } = require('./demo-seed');
const DEMO_CREATION_KEY = process.env.DEMO_CREATION_KEY || '';

function requireDemoKey(req, res, next) {
  if (DEMO_CREATION_KEY.length < 32) {
    return res.status(503).json({ error: 'DEMO_CREATION_KEY no configurada (mínimo 32 caracteres) en Railway' });
  }
  const given = Buffer.from(String(req.headers['x-demo-key'] || ''));
  const expected = Buffer.from(DEMO_CREATION_KEY);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(403).json({ error: 'Clave de demos incorrecta' });
  }
  next();
}

function generateDemoPassword() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += alphabet[crypto.randomInt(alphabet.length)];
  return `demo-${s}`;
}

async function sendDemoEmail({ to, ownerName, businessName, password, expiresAt }) {
  const loginUrl = `${APP_URL.replace(/\/$/, '')}/central-registro.html?email=${encodeURIComponent(to)}`;
  const exp = new Date(expiresAt).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
  await sendEmail({
    to,
    subject: 'Tu demo de CENTRAL está listo 🚀',
    html: `
<div style="font-family:-apple-system,'Segoe UI',Arial,sans-serif;background:#0d0d14;padding:32px 16px;">
  <div style="max-width:520px;margin:0 auto;background:#15151f;border:1px solid #2a2a3a;border-radius:16px;padding:32px;color:#e8e8f0;">
    <div style="font-size:22px;font-weight:800;margin-bottom:6px;">Hola ${escHtml(ownerName || '')} 👋</div>
    <div style="color:#9999bb;font-size:15px;line-height:1.6;margin-bottom:24px;">
      Preparamos una demo de CENTRAL para <strong style="color:#e8e8f0;">${escHtml(businessName)}</strong>, con un catálogo,
      clientes, pedidos y conversaciones de ejemplo para que pruebes todas las funciones como si fuera tu negocio.
    </div>
    <div style="background:#1f1f2e;border-radius:12px;padding:18px 20px;margin-bottom:24px;font-size:14px;line-height:1.9;">
      <div><span style="color:#9999bb;">Correo:</span> <strong>${escHtml(to)}</strong></div>
      <div><span style="color:#9999bb;">Clave temporal:</span> <strong style="font-family:monospace;font-size:15px;">${escHtml(password)}</strong></div>
      <div><span style="color:#9999bb;">Disponible hasta:</span> <strong>${exp}</strong></div>
    </div>
    <a href="${loginUrl}" style="display:inline-block;background:linear-gradient(135deg,#7c5cfc,#a78bfa);color:#fff;text-decoration:none;padding:13px 26px;border-radius:10px;font-weight:700;font-size:15px;">Entrar a mi demo →</a>
    <div style="color:#7070a0;font-size:12.5px;line-height:1.6;margin-top:28px;">
      Los mensajes que envíes en la demo no salen a WhatsApp ni Instagram: es un entorno de práctica.<br>
      ¿Dudas? Responde a este correo o escríbenos a info@magicdesignllc.com
    </div>
  </div>
</div>`,
  });
}

app.get('/api/admin/demos', requireAdmin, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const { rows } = await pool.query(`
      SELECT id, business_name, full_name, email, country, created_at, expires_at, active,
             GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - NOW())) / 86400))::int AS days_left,
             (expires_at < NOW()) AS expired
      FROM tenants WHERE is_demo = true
      ORDER BY created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/demos', requireAdmin, requireDemoKey, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  const businessName = String(b.businessName || '').trim();
  const ownerName = String(b.ownerName || '').trim();
  const city = String(b.city || '').trim() || 'Caracas';
  const country = String(b.country || '').trim() || null;
  const days = Math.min(30, Math.max(1, parseInt(b.days, 10) || 7));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Correo inválido' });
  if (!businessName) return res.status(400).json({ error: 'Falta el nombre del negocio' });

  const { rows: existing } = await pool.query('SELECT id, is_demo FROM tenants WHERE lower(email) = $1', [email]);
  if (existing.length) {
    return res.status(409).json({ error: existing[0].is_demo
      ? 'Ya existe una demo con este correo — extiéndela o reenvía el acceso desde la lista'
      : 'Este correo ya pertenece a una cuenta real de CENTRAL' });
  }

  const password = generateDemoPassword();
  const hash = await bcrypt.hash(password, 10);
  const client = await pool.connect();
  let tenant;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      INSERT INTO tenants (business_name, full_name, email, password_hash, plan, country, is_demo, demo_days, expires_at)
      VALUES ($1,$2,$3,$4,'pro',$5,true,$6, NOW() + make_interval(hours => $6 * 24))
      RETURNING id, email, business_name, expires_at
    `, [businessName, ownerName || null, email, hash, country, days]);
    tenant = rows[0];
    await seedDemoTenant(client, tenant.id, { city });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    console.error('[DEMO] Error creando demo:', err.message);
    return res.status(500).json({ error: 'No se pudo crear la demo: ' + err.message });
  }
  client.release();

  let emailSent = false, emailError = null;
  if (process.env.RESEND_API_KEY && b.sendEmail !== false) {
    try {
      await sendDemoEmail({ to: email, ownerName, businessName, password, expiresAt: tenant.expires_at });
      emailSent = true;
    } catch (err) { emailError = err.message; }
  }
  console.log(`[DEMO] Creada demo ${tenant.id} para ${email} (${days} días) por ${req.admin.email}`);
  res.json({ success: true, tenantId: tenant.id, email, password, expiresAt: tenant.expires_at, emailSent, emailError });
});

app.post('/api/admin/demos/:tenantId/extend', requireAdmin, requireDemoKey, async (req, res) => {
  const days = Math.min(30, Math.max(1, parseInt(req.body?.days, 10) || 7));
  try {
    const { rows } = await pool.query(`
      UPDATE tenants SET expires_at = GREATEST(expires_at, NOW()) + make_interval(hours => $2 * 24), active = true
      WHERE id = $1 AND is_demo = true RETURNING expires_at
    `, [req.params.tenantId, days]);
    if (!rows[0]) return res.status(404).json({ error: 'Demo no encontrada' });
    res.json({ success: true, expiresAt: rows[0].expires_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/demos/:tenantId/revoke', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE tenants SET expires_at = NOW() WHERE id = $1 AND is_demo = true RETURNING id`,
      [req.params.tenantId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Demo no encontrada' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/demos/:tenantId/resend', requireAdmin, requireDemoKey, async (req, res) => {
  try {
    const password = generateDemoPassword();
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `UPDATE tenants SET password_hash = $2 WHERE id = $1 AND is_demo = true
       RETURNING email, full_name, business_name, expires_at`,
      [req.params.tenantId, hash]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Demo no encontrada' });
    const t = rows[0];
    let emailSent = false, emailError = null;
    if (process.env.RESEND_API_KEY) {
      try {
        await sendDemoEmail({ to: t.email, ownerName: t.full_name, businessName: t.business_name, password, expiresAt: t.expires_at });
        emailSent = true;
      } catch (err) { emailError = err.message; }
    }
    res.json({ success: true, email: t.email, password, emailSent, emailError });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Convierte una demo en cuenta real: quita la caducidad (los datos de ejemplo se conservan)
app.post('/api/admin/demos/:tenantId/convert', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `UPDATE tenants SET is_demo = false, expires_at = NULL WHERE id = $1 AND is_demo = true RETURNING id`,
      [req.params.tenantId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Demo no encontrada' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ARRANQUE
// ══════════════════════════════════════════════════════════════
initDB().then(() => {
  server.listen(PORT, () => console.log(`🚀 CENTRAL Backend v5.0 escuchando en puerto ${PORT}`));
});
