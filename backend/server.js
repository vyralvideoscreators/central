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
const { Pool, types: pgTypes } = require('pg');
pgTypes.setTypeParser(1082, v => v); // DATE llega como 'YYYY-MM-DD' (sin convertir a la zona del servidor)
const bcrypt     = require('bcrypt');
const jwt        = require('jsonwebtoken');
const Stripe     = require('stripe');
const crypto     = require('crypto');
const { ensurePaymentsSchema, ensureOrderCycleSchema, validateOrdersKindCheck, CREDIT_METHOD, isCreditMethod, runPaymentsBackfill, recalcOrderPayment,
  normalizeMethodName, mergeMethodTotals, rawMethodsFor } = require('./pagos');
const ops = require('./operacion');
const team = require('./equipo');
const { BadRequest } = ops; // error de datos del cliente de la API (se responde 400 con este mensaje)

const app = express();
app.use(cors());
// El webhook de Stripe necesita el body sin procesar para validar la firma
// (ver /api/billing/webhook) — se excluye acá del parser JSON global.
// Para el webhook de Meta se guarda el body original: hace falta para validar su firma.
const jsonParser = express.json({
  limit: '20mb',
  verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/webhook')) req.rawBody = buf; },
});
app.use((req, res, next) => {
  if (req.originalUrl === '/api/billing/webhook') return next();
  jsonParser(req, res, next);
});

// Límite de intentos de login por IP: 10 cada 15 min (frena fuerza bruta sobre claves)
app.set('trust proxy', 1);
const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const key = req.baseUrl + '|' + req.ip;
  const now = Date.now();
  const rec = loginAttempts.get(key);
  if (rec && now <= rec.reset && rec.count >= 10) {
    return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
  }
  if (!rec || now > rec.reset) loginAttempts.set(key, { count: 1, reset: now + 15 * 60000 });
  else rec.count++;
  res.on('finish', () => { if (res.statusCode === 200) loginAttempts.delete(key); });
  next();
}
setInterval(() => { const n = Date.now(); for (const [k, v] of loginAttempts) if (n > v.reset) loginAttempts.delete(k); }, 10 * 60000).unref();
app.use(['/api/tenant/login', '/api/admin/login'], loginRateLimit);
// Cambiar contraseña o correo exige la contraseña actual. Freno propio por NEGOCIO (no por IP): solo cuentan las
// contraseñas erróneas y nada más lo reinicia (un guardado correcto de otro campo no pone el contador a cero).
const pwFailures = new Map();
const PW_MAX_FAILURES = 5;
function pwBlocked(tenantId) {
  const rec = pwFailures.get(tenantId);
  return !!(rec && Date.now() <= rec.reset && rec.count >= PW_MAX_FAILURES);
}
function pwFailed(tenantId) {
  const now = Date.now();
  const rec = pwFailures.get(tenantId);
  if (!rec || now > rec.reset) pwFailures.set(tenantId, { count: 1, reset: now + 15 * 60000 });
  else rec.count++;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of pwFailures) if (n > v.reset) pwFailures.delete(k); }, 10 * 60000).unref();
// Freno de login por USUARIO (además del de IP): 8 contraseñas erróneas en 15 min → 429. Un acierto lo reinicia.
const userLoginFailures = new Map();
const USER_LOGIN_MAX = 8;
function loginBlocked(userId) {
  const rec = userLoginFailures.get(userId);
  return !!(rec && Date.now() <= rec.reset && rec.count >= USER_LOGIN_MAX);
}
function loginFailed(userId) {
  const now = Date.now();
  const rec = userLoginFailures.get(userId);
  if (!rec || now > rec.reset) userLoginFailures.set(userId, { count: 1, reset: now + 15 * 60000 });
  else rec.count++;
}
setInterval(() => { const n = Date.now(); for (const [k, v] of userLoginFailures) if (n > v.reset) userLoginFailures.delete(k); }, 10 * 60000).unref();
// Comprueba la contraseña actual con el freno. Devuelve null si es correcta, o [status, mensaje].
async function checkCurrentPassword(tenantId, pw, hash) {
  // Comprobar y apuntar el intento es síncrono (antes de cualquier await): peticiones en paralelo no pueden
  // pasar todas antes de que se cuenten. Si acierta, el intento se borra.
  if (pwBlocked(tenantId)) return [429, 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.'];
  pwFailed(tenantId);
  if (!(await bcrypt.compare(pw, hash))) return [401, 'La contraseña actual no es correcta'];
  pwFailures.delete(tenantId);
  return null;
}
// bcrypt solo usa los primeros 72 bytes: una clave más larga se rechaza en vez de recortarse sin avisar
const PW_MAX_BYTES = 72;
const pwTooLong = (p) => Buffer.byteLength(String(p), 'utf8') > PW_MAX_BYTES;
const PW_TOO_LONG_MSG = 'La contraseña es demasiado larga (máximo 72 caracteres)';

const PORT             = process.env.PORT || 3000;
const GRAPH_API_VERSION = 'v21.0';
const GRAPH_BASE       = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const DEV_JWT_SECRET   = 'central_jwt_dev_secret_cambiar_en_prod';
if (!process.env.JWT_SECRET || process.env.JWT_SECRET === DEV_JWT_SECRET) {
  if (process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT) {
    console.error('❌ Falta JWT_SECRET (o tiene el valor de ejemplo). El servidor no arranca sin una clave propia.');
    process.exit(1);
  }
  console.warn('⚠️  JWT_SECRET no configurado — usando una clave de desarrollo (solo en local)');
}
const JWT_SECRET       = process.env.JWT_SECRET || DEV_JWT_SECRET;

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
const DEFAULT_IG_ACCT   = process.env.INSTAGRAM_ACCOUNT_ID || null;
const VERIFY_TOKEN      = process.env.WEBHOOK_VERIFY_TOKEN || '';
// Clave secreta de la app de Meta: firma (X-Hub-Signature-256) de cada llamada al webhook.
// INSTAGRAM_APP_SECRET es opcional, para cuando Instagram usa una app distinta.
const META_APP_SECRET      = process.env.META_APP_SECRET || '';
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET || '';
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// ── In-memory media cache (binarios no van a DB) ──────────────
const mediaCache = {};

// ══════════════════════════════════════════════════════════════
// POSTGRESQL
// ══════════════════════════════════════════════════════════════
let pool = null;
let dbReady = false;

if (process.env.DATABASE_URL) {
  // max explícito (por defecto 10 por réplica): con las listas y los informes pesados, el límite del pool es parte del diseño
  const poolMax = parseInt(process.env.PG_POOL_MAX, 10);
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: Number.isInteger(poolMax) && poolMax > 0 ? poolMax : 10,
  });
}

let backfillAfterListen = false; // relleno de pagos en segundo plano tras listen (ver initDB)
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

    // Recuperación de clave (en bases creadas antes de que existieran estas columnas)
    try {
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reset_token TEXT`);
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP`);
    } catch (err) {
      console.error('⚠️  Migración reset_token:', err.message);
    }

    // Respuesta automática fuera de horario (apagada por defecto)
    try {
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS auto_reply_enabled BOOLEAN DEFAULT false`);
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS off_hours_message TEXT`);
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS business_hours JSONB`);
      await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS timezone TEXT`);
      await pool.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS last_auto_reply_at TIMESTAMPTZ`);
    } catch (err) {
      console.error('⚠️  Migración respuesta automática:', err.message);
    }

    // Correos en minúsculas + índice único sin distinguir mayúsculas. Si dos cuentas
    // chocaran al pasarlas a minúsculas, no se tocan y el índice no se crea (queda en el log).
    try {
      await pool.query(`
        UPDATE tenants t SET email = lower(trim(t.email))
        WHERE t.email <> lower(trim(t.email))
          AND NOT EXISTS (SELECT 1 FROM tenants o WHERE o.id <> t.id AND lower(trim(o.email)) = lower(trim(t.email)))
      `);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS tenants_email_lower_uniq ON tenants (lower(email))`);
    } catch (err) {
      console.error('⚠️  Migración correos en minúsculas:', err.message);
    }

    // Numeración de pedidos propia de cada negocio (#0001, #0002…). Idempotente: solo
    // numera los pedidos que aún no tienen número, siguiendo el orden de creación.
    {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS order_seq INTEGER NOT NULL DEFAULT 0`);
        await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS tenant_order_number INTEGER`);
        // Los presupuestos (Fase 3, orders.kind='quote') NO llevan número de pedido hasta convertirse.
        // En el primer despliegue la columna kind aún no existe (la crea ensureOrderCycleSchema después).
        const { rows: kindCol } = await client.query(`SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'kind'`);
        const notQuote = kindCol.length ? `AND o.kind IS DISTINCT FROM 'quote'` : '';
        await client.query(`
          WITH base AS (
            SELECT tenant_id, COALESCE(MAX(tenant_order_number), 0) AS mx FROM orders GROUP BY tenant_id
          ), n AS (
            SELECT o.id, b.mx + ROW_NUMBER() OVER (PARTITION BY o.tenant_id ORDER BY o.created_at, o.order_number) AS rn
            FROM orders o JOIN base b ON b.tenant_id = o.tenant_id
            WHERE o.tenant_order_number IS NULL ${notQuote}
          )
          UPDATE orders o SET tenant_order_number = n.rn FROM n WHERE o.id = n.id
        `);
        await client.query(`
          UPDATE tenants t SET order_seq = s.mx
          FROM (SELECT tenant_id, MAX(tenant_order_number) AS mx FROM orders GROUP BY tenant_id) s
          WHERE t.id = s.tenant_id AND t.order_seq < s.mx
        `);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS orders_tenant_order_number_uniq ON orders (tenant_id, tenant_order_number)`);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('⚠️  Migración numeración de pedidos:', err.message);
      } finally {
        client.release();
      }
    }

    // Pedidos vinculados a la ficha del cliente (no por nombre). Nada se borra:
    // - clients.convo_key: la conversación (waId o ig_…) de la que salió la ficha
    // - los pedidos antiguos sin ficha se vinculan SOLO si hay exactamente un cliente con ese nombre
    // El relleno de pedidos antiguos corre UNA sola vez (cuando se crea la columna): después,
    // un pedido sin ficha es decisión del usuario y no se vuelve a vincular solo.
    {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows: col } = await client.query(
          `SELECT 1 FROM information_schema.columns WHERE table_name = 'clients' AND column_name = 'convo_key'`);
        await client.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS convo_key TEXT`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS clients_tenant_convo_key_uniq ON clients (tenant_id, convo_key) WHERE convo_key IS NOT NULL`);
        await client.query(`CREATE INDEX IF NOT EXISTS orders_tenant_client_idx ON orders (tenant_id, client_id)`);
        if (!col[0]) {
          const { rowCount } = await client.query(`
            UPDATE orders o SET client_id = c.id
            FROM clients c
            WHERE o.client_id IS NULL AND c.tenant_id = o.tenant_id AND c.name = o.client_name
              AND (SELECT COUNT(*) FROM clients c2 WHERE c2.tenant_id = o.tenant_id AND c2.name = o.client_name) = 1
          `);
          console.log(`✅ Pedidos ↔ fichas: ${rowCount} pedido(s) antiguos vinculados a su ficha`);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('❌ Migración pedidos ↔ clientes (sin clients.convo_key fallarán altas de pedidos y clientes):', err.message);
      } finally {
        client.release();
      }
    }

    // Descuento por pedido. Los pedidos existentes quedan con descuento 0 (sin relleno).
    // Cada paso va en su propia sentencia (transacción corta) y con lock_timeout: si la tabla está ocupada
    // se rinde en 5 s en vez de dejar en cola a todas las peticiones; el siguiente arranque lo reintenta.
    //   1) ADD COLUMN con DEFAULT constante: solo toca el catálogo (instantáneo).
    //   2) CHECK NOT VALID: bloqueo breve, no recorre la tabla.
    //   3) VALIDATE: recorre la tabla pero sin bloquear lecturas ni escrituras (SHARE UPDATE EXCLUSIVE).
    //   La columna es imprescindible (las altas y ediciones de pedidos la usan): se reintenta y, si al final
    //   no existe, el proceso sale para que Railway no dé por bueno un despliegue que rompería los pedidos.
    {
      const hasDiscount = async c => (await c.query(
        `SELECT 1 FROM pg_attribute WHERE attrelid = 'orders'::regclass AND attname = 'discount' AND NOT attisdropped`)).rows.length > 0;
      const client = await pool.connect();
      try {
        await client.query(`SET lock_timeout = '5s'`);
        // Solo se pide el bloqueo si falta la columna (ADD COLUMN IF NOT EXISTS lo pediría en cada arranque)
        for (let attempt = 1; !(await hasDiscount(client)); attempt++) {
          try {
            await client.query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount NUMERIC(10,2) NOT NULL DEFAULT 0`);
          } catch (err) {
            if (attempt >= 4) throw err;
            console.warn(`⚠️  orders.discount: tabla ocupada (intento ${attempt}), reintento…`, err.message);
            await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
          }
        }
        try {
          await client.query(`
            DO $$ BEGIN
              IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_discount_nonneg' AND conrelid = 'orders'::regclass) THEN
                ALTER TABLE orders ADD CONSTRAINT orders_discount_nonneg CHECK (discount >= 0) NOT VALID;
              END IF;
            END $$
          `);
          const { rows } = await client.query(
            `SELECT convalidated FROM pg_constraint WHERE conname = 'orders_discount_nonneg' AND conrelid = 'orders'::regclass`);
          if (rows[0] && !rows[0].convalidated) await client.query(`ALTER TABLE orders VALIDATE CONSTRAINT orders_discount_nonneg`);
        } catch (err) {
          // 42710: otra réplica la creó a la vez (inofensivo). El CHECK es una protección extra: no impide arrancar.
          if (err.code !== '42710') console.error('⚠️  CHECK orders_discount_nonneg (se reintentará en el próximo arranque):', err.message);
        }
      } catch (err) {
        console.error('❌ Migración descuento de pedidos:', err.message);
      } finally {
        await client.query('RESET lock_timeout').catch(() => {});
        client.release();
      }
      if (!(await hasDiscount(pool))) {
        console.error('❌ Falta orders.discount: los pedidos fallarían. Se detiene el arranque para reintentar.');
        process.exit(1);
      }
    }

    // Fase 2 — pagos de verdad: tablas payments / order_events / tenant_settings, orders.amount_paid,
    // tenants.base_currency (ver pagos.js y migrations/2026-11-25-pagos.sql). Sin ellas los pedidos
    // fallarían (amount_paid): si falta de verdad el esquema, se detiene el arranque y Railway conserva
    // la versión anterior.
    // Hasta 4 intentos con espera (1, 2, 4 s): un lock_timeout puntual con la versión vieja ocupada no
    // debe tumbar el despliegue.
    let paymentsReady = false;
    for (let attempt = 1; attempt <= 4 && !paymentsReady; attempt++) {
      paymentsReady = await ensurePaymentsSchema(pool);
      if (!paymentsReady && attempt < 4) await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    if (!paymentsReady) {
      console.error('❌ Falta el esquema de pagos. Se detiene el arranque para reintentar.');
      process.exit(1);
    }
    // Fase 3 — ciclo del pedido: presupuestos, anulación, impuesto, devoluciones y saldo a favor (ver
    // pagos.js → ensureOrderCycleSchema y migrations/2026-11-26-ciclo-pedido.sql). Mismo criterio que arriba.
    let cycleReady = false;
    for (let attempt = 1; attempt <= 4 && !cycleReady; attempt++) {
      cycleReady = await ensureOrderCycleSchema(pool);
      if (!cycleReady && attempt < 4) await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    if (!cycleReady) {
      console.error('❌ Falta el esquema del ciclo del pedido. Se detiene el arranque para reintentar.');
      process.exit(1);
    }
    // Fase 4A — gastos, cierre de caja, costo y existencias (ver operacion.js y migrations/2026-11-27-gastos-existencias.sql).
    // Mismo criterio: sin este esquema las altas de pedidos fallarían (order_items.unit_cost / variant_key).
    let opsReady = false;
    for (let attempt = 1; attempt <= 4 && !opsReady; attempt++) {
      opsReady = await ops.ensureStockExpensesSchema(pool);
      if (!opsReady && attempt < 4) await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    if (!opsReady) {
      console.error('❌ Falta el esquema de gastos y existencias. Se detiene el arranque para reintentar.');
      process.exit(1);
    }
    // Fase 4B — equipo con roles y quién hizo qué (ver equipo.js y migrations/2026-11-28-equipo.sql). Mismo criterio: sin
    // team_users nadie podría iniciar sesión, así que se detiene el arranque y Railway conserva la versión anterior.
    let teamReady = false;
    for (let attempt = 1; attempt <= 4 && !teamReady; attempt++) {
      teamReady = await team.ensureTeamSchema(pool);
      if (!teamReady && attempt < 4) await new Promise(r => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
    if (!teamReady) {
      console.error('❌ Falta el esquema del equipo. Se detiene el arranque para reintentar.');
      process.exit(1);
    }
    try { await team.runTeamBackfill(pool); } catch (err) { console.error('⚠️  Relleno del dueño del equipo:', err.message); }
    // Zona horaria desde el país (ver backfillTenantTimezones): rápido e idempotente; un fallo solo se registra
    try { await backfillTenantTimezones(); } catch (err) { console.error('⚠️  Relleno de zonas horarias:', err.message); }
    // Relleno de pedidos pagados "a la antigua" (por lotes; un fallo solo se registra). En el PRIMER arranque
    // de la Fase 2 (sin la marca) se espera antes de escuchar, para que nadie vea un pedido pagado con saldo.
    // Después corre en segundo plano tras listen y otra vez a los 10 min (recoge lo que la versión vieja
    // marcara como pagado durante el solape del despliegue), sin retrasar nunca el arranque.
    const { rows: relleno } = await pool.query(`SELECT 1 FROM schema_migrations WHERE name = '2026-11-25-pagos-relleno'`);
    if (!relleno.length) await runPaymentsBackfill(pool);
    else backfillAfterListen = true;

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
  const email    = process.env.DEFAULT_TENANT_EMAIL ? normEmail(process.env.DEFAULT_TENANT_EMAIL) : '';
  const password = process.env.DEFAULT_TENANT_PASSWORD;
  if (!email || !password) return;

  const { rows } = await pool.query('SELECT id FROM tenants WHERE lower(email) = $1', [email]);
  if (rows.length > 0) {
    // Actualizar credenciales de WhatsApp/Instagram si cambiaron
    await pool.query(`
      UPDATE tenants SET
        whatsapp_phone_number_id = COALESCE($1, whatsapp_phone_number_id),
        whatsapp_token           = COALESCE($2, whatsapp_token),
        instagram_access_token   = COALESCE($3, instagram_access_token),
        instagram_account_id     = COALESCE($4, instagram_account_id)
      WHERE lower(email) = $5
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

// Los correos se guardan y comparan siempre en minúsculas y sin espacios
function normEmail(e) { return String(e ?? '').trim().toLowerCase(); }

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

// Chats paginados (Fase 4B). Sin parámetros se conserva la respuesta de siempre (arreglo), con un tope razonable.
const LEGACY_CONVOS_CAP = 300, LEGACY_MSGS_PER_CONVO = 200, CONVO_PAGE_DEFAULT = 100, CONVO_PAGE_MAX = 200, CONVO_PREVIEW_MSGS = 20;
const TS_US = `to_char(%COL%, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
const tsText = (col) => TS_US.replace('%COL%', col);
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?$/;
const encodeCursor = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function decodeCursor(s) {
  try { const o = JSON.parse(Buffer.from(String(s), 'base64url').toString('utf8')); return o && typeof o === 'object' ? o : null; } catch { return null; }
}
// Texto de búsqueda para ILIKE (se escapan % _ \)
const likeOf = (q) => '%' + String(q).replace(/[\\%_]/g, c => '\\' + c) + '%';
const MSG_JSON = `json_build_object(
  'id', m.id, 'role', m.role, 'type', m.type, 'text', m.text,
  'mediaId', m.media_id, 'mimeType', m.mime_type, 'mediaUrl', m.media_url,
  'caption', m.caption, 'filename', m.filename, 'orderType', m.order_type,
  'time', to_char(m.time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))`;

// Lista de chats con sus últimos mensajes. opts: { limit, cursor, q, msgs }. Devuelve { rows, nextCursor }.
async function dbListConversations(tenantId, opts = {}) {
  if (!dbReady) return { conversations: [], nextCursor: null };
  const limit = Math.min(opts.max || CONVO_PAGE_MAX, Math.max(1, parseInt(opts.limit, 10) || CONVO_PAGE_DEFAULT));
  const msgs = Math.min(200, Math.max(1, parseInt(opts.msgs, 10) || CONVO_PREVIEW_MSGS));
  const P = [tenantId];
  const where = ['c.tenant_id = $1'];
  if (opts.q) { P.push(likeOf(opts.q)); where.push(`(c.name ILIKE $${P.length} ESCAPE '\\' OR c.wa_id ILIKE $${P.length} ESCAPE '\\')`); }
  if (opts.cursor) {
    const cur = decodeCursor(opts.cursor);
    if (!cur || typeof cur.w !== 'string' || (cur.t !== null && !TS_RE.test(String(cur.t)))) throw new BadRequest('Cursor inválido');
    P.push(cur.w);
    const wi = P.length;
    if (cur.t === null) where.push(`(c.last_message_at IS NULL AND c.wa_id > $${wi})`);
    else { P.push(cur.t); where.push(`(c.last_message_at IS NULL OR c.last_message_at < $${P.length}::timestamp OR (c.last_message_at = $${P.length}::timestamp AND c.wa_id > $${wi}))`); }
  }
  P.push(limit + 1);
  const { rows } = await pool.query(`
    SELECT c.wa_id, c.name, c.platform, c.ig_sender_id, c.last_message_at, ${tsText('c.last_message_at')} AS last_txt,
           COALESCE(mm.msgs, '[]'::json) AS messages
    FROM (SELECT * FROM conversations c WHERE ${where.join(' AND ')}
          ORDER BY c.last_message_at DESC NULLS LAST, c.wa_id LIMIT $${P.length}) c
    LEFT JOIN LATERAL (
      SELECT json_agg(x.j ORDER BY x.t, x.id) AS msgs FROM (
        SELECT ${MSG_JSON} AS j, m.time AS t, m.id FROM messages m
        WHERE m.tenant_id = c.tenant_id AND m.wa_id = c.wa_id ORDER BY m.time DESC, m.id DESC LIMIT ${msgs}) x
    ) mm ON true
    ORDER BY c.last_message_at DESC NULLS LAST, c.wa_id`, P);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    conversations: page.map(r => ({ waId: r.wa_id, name: r.name, platform: r.platform, igSenderId: r.ig_sender_id,
      lastMessageAt: r.last_message_at, messages: r.messages || [] })),
    nextCursor: rows.length > limit && last ? encodeCursor({ t: last.last_txt || null, w: last.wa_id }) : null,
  };
}
// Respuesta de siempre (arreglo): los chats más recientes con sus últimos mensajes
async function dbGetConversations(tenantId) {
  return (await dbListConversations(tenantId, { limit: LEGACY_CONVOS_CAP, max: LEGACY_CONVOS_CAP, msgs: LEGACY_MSGS_PER_CONVO })).conversations;
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

function money2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

const DELIVERY_STATUSES = ['to_deliver', 'preparing', 'on_the_way', 'delivered', 'not_delivered']; // 'cancelled' solo por /cancel
const pad4 = (n) => String(n).padStart(4, '0');
function mapOrderRow(r) {
  const isQuote = r.kind === 'quote';
  const items = r.items || [];
  const total = Number(r.total_price || 0), credited = money2(r.credited_total);
  const effective = money2(total - credited);
  return {
    id:                  r.id,
    kind:                isQuote ? 'quote' : 'order',
    orderNumber:         isQuote ? 'P-' + pad4(r.quote_number || 0) : '#' + pad4(r.tenant_order_number ?? r.order_number),
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
    discount:            r.discount ?? 0,
    // Impuesto: foto tomada al crear (taxRate en %, taxAmount en moneda base). subtotal = Σ artículos
    taxRate:             Number(r.tax_rate || 0),
    taxAmount:           money2(r.tax_amount),
    subtotal:            items.length ? money2(items.reduce((a, i) => a + Number(i.linePrice || 0), 0))
                           : money2(total - Number(r.shipping || 0) + Number(r.discount || 0) - Number(r.tax_amount || 0)),
    deliveryDate:        r.delivery_date || null,
    deliveryZone:        r.delivery_zone || null,
    cancelled:           r.delivery_status === 'cancelled',
    cancelledAt:         r.cancelled_at || null,
    cancelReason:        r.cancel_reason || null,
    // Cobro: derivado de los pagos (payStatus: pend | partial | ok). amountPaid = cobrado NETO (pagos − reembolsos)
    // y balance, en moneda base. creditedTotal = Σ notas de crédito; effectiveTotal = totalPrice − creditedTotal.
    amountPaid:          money2(r.amount_paid),
    creditedTotal:       credited,
    effectiveTotal:      effective,
    balance:             (isQuote || r.delivery_status === 'cancelled') ? 0 : Math.max(0, money2(effective - Number(r.amount_paid || 0))),
    createdAt:           r.created_at,
    updatedAt:           r.updated_at,
    createdByUserId:     r.created_by_user_id || null,
    items,
  };
}

// Pedidos paginados (Fase 4B). Sin parámetros: el arreglo de siempre (los 1000 más recientes). Con limit/before/filtros:
// { orders, nextCursor, counts }, 100 por página (máx. 200), del más reciente al más antiguo, con cursor (created_at + id).
const LEGACY_ORDERS_CAP = 1000, ORDERS_PAGE_DEFAULT = 100, ORDERS_PAGE_MAX = 200;
const ORDER_STATUSES = ['to_deliver', 'preparing', 'on_the_way', 'delivered', 'not_delivered', 'cancelled'];
const ORDER_ITEMS_JSON = `(SELECT COALESCE(json_agg(json_build_object(
    'id', oi.id, 'productId', oi.product_id, 'emoji', oi.emoji, 'name', oi.name, 'detail', oi.detail, 'qty', oi.qty,
    'unitPrice', oi.unit_price, 'linePrice', oi.line_price, 'variantKey', COALESCE(oi.variant_key, '')
  )), '[]'::json) FROM order_items oi WHERE oi.order_id = o.id AND oi.tenant_id = o.tenant_id)`;
const OWED = `(o.total_price - o.credited_total - o.amount_paid)`; // saldo por cobrar de un pedido vigente

// Filtros de servidor → { where, params } (siempre filtrado por negocio)
async function ordersFilter(tenantId, q) {
  const P = [tenantId];
  const w = ['o.tenant_id = $1'];
  const status = q.status === undefined || q.status === '' ? null : String(q.status);
  if (status && ![...ORDER_STATUSES, 'all', 'pending_pay'].includes(status)) throw new BadRequest('Estado inválido');
  const kind = q.kind === undefined || q.kind === '' ? null : String(q.kind);
  if (kind && !['quote', 'order'].includes(kind)) throw new BadRequest('Tipo inválido');
  if (kind === 'quote') w.push("o.kind = 'quote' AND o.delivery_status <> 'cancelled'");
  else if (status === 'cancelled') w.push("o.delivery_status = 'cancelled'");
  else if (status === 'all') w.push("o.kind = 'order' AND o.delivery_status <> 'cancelled'");
  else if (status === 'pending_pay') w.push(`o.kind = 'order' AND o.delivery_status <> 'cancelled' AND ${OWED} > 0.004`);
  else if (status) { P.push(status); w.push(`o.kind = 'order' AND o.delivery_status = $${P.length}`); }
  else if (kind === 'order') w.push("o.kind = 'order'");
  if (q.deliveryDate !== undefined && q.deliveryDate !== '') {
    if (!['today', 'tomorrow'].includes(String(q.deliveryDate))) throw new BadRequest('deliveryDate debe ser today o tomorrow');
    const tz = await resolveTenantTz(tenantId); // sin ubicación → 400 location_required
    P.push(tz); const zi = P.length;
    w.push(`o.kind = 'order' AND o.delivery_status NOT IN ('cancelled', 'delivered') AND o.delivery_date = ((now() AT TIME ZONE $${zi})::date + ${q.deliveryDate === 'tomorrow' ? 1 : 0})`);
  }
  if (q.orderId !== undefined && q.orderId !== '') {
    if (!UUID_RE.test(String(q.orderId))) throw new BadRequest('orderId inválido');
    P.push(String(q.orderId)); w.push(`o.id = $${P.length}`);
  }
  if (q.clientId !== undefined && q.clientId !== '') {
    if (!UUID_RE.test(String(q.clientId))) throw new BadRequest('clientId inválido');
    P.push(String(q.clientId)); w.push(`o.client_id = $${P.length}`);
  }
  if (q.q !== undefined && String(q.q).trim() !== '') {
    const text = String(q.q).trim().slice(0, 100);
    P.push(likeOf(text)); const li = P.length;
    const digits = /^(#|p-?)?0*(\d{1,9})$/i.exec(text);
    let numCond = '';
    if (digits) { P.push(parseInt(digits[2], 10)); numCond = ` OR COALESCE(o.tenant_order_number, o.quote_number) = $${P.length}`; }
    w.push(`(o.client_name ILIKE $${li} ESCAPE '\\' OR o.product_summary ILIKE $${li} ESCAPE '\\'${numCond}
      OR EXISTS (SELECT 1 FROM order_items oi2 WHERE oi2.order_id = o.id AND oi2.tenant_id = o.tenant_id AND oi2.name ILIKE $${li} ESCAPE '\\'))`);
  }
  return { w, P };
}

// Contadores de las pestañas y del inicio, calculados por el servidor sobre TODOS los pedidos (no solo los cargados)
async function ordersCounts(tenantId) {
  let tz = null;
  try { tz = await resolveTenantTz(tenantId); } catch (e) { if (!(e instanceof BadRequest)) throw e; }
  const live = "o.kind = 'order' AND o.delivery_status <> 'cancelled'";
  const dayOf = (col) => `((${col} AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE $2)::date`;
  const { rows: [r] } = await pool.query(`
    SELECT COUNT(*) FILTER (WHERE ${live})::int AS "all",
      COUNT(*) FILTER (WHERE o.kind = 'order' AND o.delivery_status = 'to_deliver')::int AS to_deliver,
      COUNT(*) FILTER (WHERE o.kind = 'order' AND o.delivery_status = 'preparing')::int AS preparing,
      COUNT(*) FILTER (WHERE o.kind = 'order' AND o.delivery_status = 'on_the_way')::int AS on_the_way,
      COUNT(*) FILTER (WHERE o.kind = 'order' AND o.delivery_status = 'delivered')::int AS delivered,
      COUNT(*) FILTER (WHERE o.kind = 'order' AND o.delivery_status = 'not_delivered')::int AS not_delivered,
      COUNT(*) FILTER (WHERE o.kind = 'quote' AND o.delivery_status <> 'cancelled')::int AS quote,
      COUNT(*) FILTER (WHERE o.delivery_status = 'cancelled')::int AS cancelled,
      COUNT(*) FILTER (WHERE ${live} AND ${OWED} > 0.004)::int AS pending_pay,
      COUNT(*) FILTER (WHERE ${live} AND o.delivery_status = 'delivered' AND ${OWED} > 0.004)::int AS delivered_unpaid,
      COALESCE(SUM(${OWED}) FILTER (WHERE ${live} AND ${OWED} > 0.004), 0)::float AS owed,
      COUNT(*) FILTER (WHERE ${live} AND $2::text IS NOT NULL AND o.delivery_status <> 'delivered' AND o.delivery_date = (now() AT TIME ZONE $2)::date)::int AS today,
      COUNT(*) FILTER (WHERE ${live} AND $2::text IS NOT NULL AND o.delivery_status <> 'delivered' AND o.delivery_date = (now() AT TIME ZONE $2)::date + 1)::int AS tomorrow,
      COUNT(*) FILTER (WHERE ${live} AND $2::text IS NOT NULL AND ${dayOf('o.created_at')} = (now() AT TIME ZONE $2)::date)::int AS orders_today,
      COALESCE(SUM(o.total_price) FILTER (WHERE ${live} AND $2::text IS NOT NULL AND ${dayOf('o.created_at')} = (now() AT TIME ZONE $2)::date), 0)::float AS sales_today,
      COUNT(*) FILTER (WHERE ${live} AND $2::text IS NOT NULL AND ${dayOf('o.created_at')} = (now() AT TIME ZONE $2)::date - 1)::int AS orders_yesterday,
      COALESCE(SUM(o.total_price) FILTER (WHERE ${live} AND $2::text IS NOT NULL AND ${dayOf('o.created_at')} = (now() AT TIME ZONE $2)::date - 1), 0)::float AS sales_yesterday
    FROM orders o WHERE o.tenant_id = $1`, [tenantId, tz]);
  return {
    all: r.all, to_deliver: r.to_deliver, preparing: r.preparing, on_the_way: r.on_the_way, delivered: r.delivered, not_delivered: r.not_delivered,
    quote: r.quote, cancelled: r.cancelled, pending_pay: r.pending_pay, delivered_unpaid: r.delivered_unpaid, owed: money2(r.owed), today: r.today, tomorrow: r.tomorrow,
    ordersToday: r.orders_today, salesToday: money2(r.sales_today), ordersYesterday: r.orders_yesterday, salesYesterday: money2(r.sales_yesterday),
  };
}

async function dbListOrders(tenantId, q = {}) {
  if (!dbReady) return { orders: [], nextCursor: null, counts: null };
  const limit = Math.min(q._legacy ? LEGACY_ORDERS_CAP : ORDERS_PAGE_MAX, Math.max(1, parseInt(q.limit, 10) || ORDERS_PAGE_DEFAULT));
  const { w, P } = await ordersFilter(tenantId, q);
  if (q.before) {
    const cur = decodeCursor(q.before);
    if (!cur || !TS_RE.test(String(cur.c)) || !UUID_RE.test(String(cur.i))) throw new BadRequest('Cursor inválido');
    P.push(cur.c, cur.i);
    w.push(`(o.created_at, o.id) < ($${P.length - 1}::timestamp, $${P.length}::uuid)`);
  }
  P.push(limit + 1);
  const { rows } = await pool.query(`
    SELECT o.*, ${ORDER_ITEMS_JSON} AS items, ${tsText('o.created_at')} AS cursor_ts
    FROM (SELECT o.* FROM orders o WHERE ${w.join(' AND ')} ORDER BY o.created_at DESC, o.id DESC LIMIT $${P.length}) o
    ORDER BY o.created_at DESC, o.id DESC`, P);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const orders = await ops.attachByName(pool, tenantId, page.map(mapOrderRow), ops.BY_CREATED);
  return {
    orders,
    nextCursor: rows.length > limit && last ? encodeCursor({ c: last.cursor_ts, i: last.id }) : null,
    counts: q.before || q._legacy ? undefined : await ordersCounts(tenantId),
  };
}
// Respuesta de siempre (arreglo): los pedidos más recientes, con un tope
async function dbGetOrders(tenantId) {
  const out = await dbListOrders(tenantId, { limit: LEGACY_ORDERS_CAP, _legacy: true });
  return out.orders;
}

// Inserta los artículos de un pedido. El producto del catálogo solo se enlaza si es de ESTE negocio (si no, queda sin
// enlace). Guarda la clave de variante y, en pedidos (no presupuestos), la FOTO del costo del producto en ese momento:
// cambiar el costo después no altera la utilidad de lo ya vendido. oldCosts (edición): conserva la foto de las líneas
// que ya existían. Devuelve las líneas para las existencias: [{ productId, variantKey, qty }].
async function insertOrderItems(db, tenantId, orderId, items, { snapshotCost, oldCosts = null }) {
  const ids = [...new Set(items.map(i => i.productId).filter(Boolean))];
  const prods = new Map();
  if (ids.length) {
    const { rows } = await db.query('SELECT id, cost FROM catalog_products WHERE tenant_id = $1 AND id = ANY($2::uuid[])', [tenantId, ids]);
    for (const r of rows) prods.set(r.id, r);
  }
  const lines = [];
  for (const it of items) {
    const p = it.productId ? prods.get(it.productId) : null;
    const vk = it.variantKey || '';
    let cost = null;
    if (snapshotCost && p) {
      const k = p.id + '|' + vk;
      cost = oldCosts && oldCosts.has(k) ? oldCosts.get(k) : (p.cost === null || p.cost === undefined ? null : Number(p.cost));
    }
    await db.query(`
      INSERT INTO order_items (order_id, tenant_id, product_id, emoji, name, detail, qty, unit_price, line_price, variant_key, unit_cost)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
      orderId, tenantId, p ? p.id : null, it.emoji, it.name, it.detail, it.qty, it.unitPrice, it.linePrice, vk || null, cost]);
    lines.push({ productId: p ? p.id : null, variantKey: vk, qty: it.qty });
  }
  return lines;
}

async function dbCreateOrder(tenantId, data, actor = null) {
  if (!dbReady) return null;
  // Presupuesto o pedido (Fase 3). Un presupuesto no admite cobros ni se numera como pedido.
  const kind = data.kind === undefined || data.kind === null || data.kind === '' ? 'order' : data.kind;
  if (kind !== 'order' && kind !== 'quote') throw new BadRequest('Tipo de documento inválido');
  const isQuote = kind === 'quote';
  if (isQuote && data.initialPayment !== undefined && data.initialPayment !== null) throw new BadRequest('Un presupuesto no admite cobros: conviértelo en pedido primero');
  const deliveryStatus = data.deliveryStatus === undefined || data.deliveryStatus === null || data.deliveryStatus === '' ? 'to_deliver' : data.deliveryStatus;
  if (!DELIVERY_STATUSES.includes(deliveryStatus)) throw new BadRequest('Estado de entrega inválido');
  const deliveryDate = cleanDeliveryDate(data.deliveryDate);
  const deliveryZone = cleanDeliveryZone(data.deliveryZone);
  // Validación y total ANTES de abrir la transacción: el servidor calcula el total, no el cliente
  const items = cleanOrderItems(data.items || []);
  const shipping = cleanMoneyField(data.shipping, 'Costo de envío');
  const discount = cleanMoneyField(data.discount, 'Descuento');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Impuesto: foto de la tasa vigente al crear (solo si hay artículos sobre los que calcularlo)
    const taxRate = items.length ? await getTenantTaxRate(client, tenantId) : 0;
    const amounts = items.length ? computeOrderAmounts(items, shipping, discount, taxRate) : null;
    const total = amounts ? amounts.total : cleanMoneyField(data.totalPrice, 'Total');
    // Siguiente número del negocio (pedido: #0001; presupuesto: P-0001, contador propio). El UPDATE bloquea
    // la fila del tenant, así dos documentos simultáneos nunca reciben el mismo número.
    const { rows: seqRows } = await client.query(isQuote ? `
      UPDATE tenants SET quote_seq = GREATEST(quote_seq,
        COALESCE((SELECT MAX(quote_number) FROM orders WHERE tenant_id = $1), 0)) + 1
      WHERE id = $1 RETURNING quote_seq AS seq
    ` : `
      UPDATE tenants SET order_seq = GREATEST(order_seq,
        COALESCE((SELECT MAX(tenant_order_number) FROM orders WHERE tenant_id = $1), 0)) + 1
      WHERE id = $1 RETURNING order_seq AS seq
    `, [tenantId]);
    if (!seqRows[0]) throw new Error('Tenant no encontrado');
    const { clientId, createdClient } = await resolveOrderClient(client, tenantId, data);
    const { rows } = await client.query(`
      INSERT INTO orders (tenant_id, client_id, client_name, platform, product_summary,
        total_price, pay_status, delivery_status, pay_method_label, delivery_method_label,
        address, notes, shipping, tenant_order_number, discount,
        kind, quote_number, tax_rate, tax_amount, delivery_date, delivery_zone, created_by_user_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      RETURNING *
    `, [
      tenantId, clientId, data.clientName || null, data.platform || null,
      data.productSummary || null, total, 'pend', // el estado de cobro lo derivan los pagos (payStatus del body se ignora)
      deliveryStatus, data.payMethodLabel || null,
      data.deliveryMethodLabel || null, data.address || null, data.notes || null,
      shipping, isQuote ? null : seqRows[0].seq, discount,
      kind, isQuote ? seqRows[0].seq : null, amounts ? taxRate : 0, amounts ? amounts.tax : 0, deliveryDate, deliveryZone, actorId(actor),
    ]);
    const order = rows[0];

    const stockLines = await insertOrderItems(client, tenantId, order.id, items, { snapshotCost: !isQuote });

    await addOrderEvent(client, tenantId, order.id, 'created', {
      total, items: items.length, clientName: data.clientName || null, platform: data.platform || null, kind }, actor);
    // Pago inicial opcional: nace en la misma transacción que el pedido (nunca se marca pagado sin pago)
    if (data.initialPayment !== undefined && data.initialPayment !== null) {
      if (typeof data.initialPayment !== 'object' || Array.isArray(data.initialPayment)) throw new BadRequest('El pago inicial no es válido');
      const r = await addPaymentTx(client, tenantId, order.id, data.initialPayment, actor);
      Object.assign(order, r.order);
    }
    // Existencias (Fase 4A): un pedido descuenta lo que vende; un presupuesto no (descuenta al convertirse). Va DESPUÉS del
    // pago inicial: el orden de bloqueo es pedido → tenant → cliente (saldo a favor) → existencias.
    if (!isQuote) await ops.syncOrderStock(client, tenantId, order.id, stockLines, 'sale', actor);
    // Los artículos se leen DENTRO de la transacción, con la misma conexión: pedir otra al pool mientras esta sigue
    // tomada deja el servidor colgado cuando llegan a la vez tantos pedidos como conexiones hay.
    const { rows: itemRows } = await client.query(
      'SELECT id, product_id, variant_key, emoji, name, detail, qty, unit_price, line_price FROM order_items WHERE order_id = $1 AND tenant_id = $2 ORDER BY ctid',
      [order.id, tenantId]
    );
    await client.query('COMMIT');
    order.items = itemRows.map(i => ({
      id: i.id, productId: i.product_id, emoji: i.emoji, name: i.name,
      detail: i.detail, qty: i.qty, unitPrice: i.unit_price, linePrice: i.line_price, variantKey: i.variant_key || '',
    }));
    const result = mapOrderRow(order);
    await ops.withName(client, tenantId, result, ops.BY_CREATED);
    if (createdClient) result.createdClient = createdClient;
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const CONVO_KEY_RE = /^(ig_)?[0-9A-Za-z_-]{1,64}$/;

// Asigna un chat a una ficha que aún no tiene. Si otra petición simultánea se lo dio a otra
// ficha, simplemente no se asigna (el savepoint evita que el choque anule el pedido).
async function linkClientToConvo(db, tenantId, clientId, convoKey) {
  await db.query('SAVEPOINT link_convo');
  try {
    await db.query(`
      UPDATE clients SET convo_key = $3 WHERE id = $2 AND tenant_id = $1 AND convo_key IS NULL
        AND NOT EXISTS (SELECT 1 FROM clients WHERE tenant_id = $1 AND convo_key = $3)`,
      [tenantId, clientId, convoKey]);
    await db.query('RELEASE SAVEPOINT link_convo');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT link_convo');
    if (err.code !== '23505') throw err;
  }
}

// Ficha del cliente de un pedido (dentro de la transacción del pedido):
// - clientId dado → debe ser de este negocio
// - sin clientId → la ficha de esa conversación si tiene el mismo nombre; si no, se crea una nueva
async function resolveOrderClient(db, tenantId, data) {
  if (data.clientId) {
    const { rows } = await db.query('SELECT id FROM clients WHERE id::text = $1 AND tenant_id = $2', [String(data.clientId), tenantId]);
    if (!rows[0]) throw new BadRequest('Cliente no encontrado');
    // La app la eligió como "la ficha de este chat": se le asigna el chat si aún no tiene uno
    if (typeof data.clientConvoKey === 'string' && CONVO_KEY_RE.test(data.clientConvoKey)) {
      await linkClientToConvo(db, tenantId, rows[0].id, data.clientConvoKey);
    }
    return { clientId: rows[0].id, createdClient: null };
  }
  const name = String(data.clientName || '').trim();
  if (!name) return { clientId: null, createdClient: null };
  const convoKey = typeof data.clientConvoKey === 'string' && CONVO_KEY_RE.test(data.clientConvoKey) ? data.clientConvoKey : null;
  if (convoKey) {
    const { rows } = await db.query(
      'SELECT id FROM clients WHERE tenant_id = $1 AND convo_key = $2 AND lower(name) = lower($3)',
      [tenantId, convoKey, name]);
    if (rows[0]) return { clientId: rows[0].id, createdClient: null };
  }
  // Fichas anteriores a convo_key (o sin chat): si hay UNA sola sin chat con ese nombre, es esa.
  // Se le asigna el chat (si está libre) para que la próxima vez se encuentre directamente.
  const { rows: byName } = await db.query(
    'SELECT id FROM clients WHERE tenant_id = $1 AND convo_key IS NULL AND lower(name) = lower($2) LIMIT 2',
    [tenantId, name]);
  if (byName.length === 1) {
    if (convoKey) {
      await linkClientToConvo(db, tenantId, byName[0].id, convoKey);
    }
    return { clientId: byName[0].id, createdClient: null };
  }
  const isIg = convoKey ? convoKey.startsWith('ig_') : data.platform === 'ig';
  const phone = typeof data.clientPhone === 'string' ? data.clientPhone.trim().slice(0, 40) || null : null;
  const insert = (key) => db.query(`
    INSERT INTO clients (tenant_id, name, phone, channel, convo_key)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (tenant_id, convo_key) WHERE convo_key IS NOT NULL DO NOTHING
    RETURNING *
  `, [tenantId, name.slice(0, 200), phone, isIg ? 'ig' : 'wa', key]);
  // Si el chat ya tiene otra ficha (u otra petición simultánea la acaba de crear), la nueva va sin chat
  let { rows } = await insert(convoKey);
  if (!rows[0]) {
    const { rows: owner } = await db.query(
      'SELECT id FROM clients WHERE tenant_id = $1 AND convo_key = $2 AND lower(name) = lower($3)', [tenantId, convoKey, name]);
    if (owner[0]) return { clientId: owner[0].id, createdClient: null };
    ({ rows } = await insert(null));
  }
  return { clientId: rows[0].id, createdClient: mapClientRow(rows[0]) };
}

// Límite de NUMERIC(10,2)
const MAX_MONEY = 99999999.99;
function cleanMoneyField(v, label) {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) throw new BadRequest(label + ' inválido');
  return Math.round(n * 100) / 100;
}
// Total de un pedido con artículos: Σ subtotales + envío − descuento (en centavos, sin errores de coma flotante)
// Fase 3: subtotal = Σ líneas; base = max(0, subtotal − descuento); impuesto = round2(base × tasa / 100);
// total = subtotal − descuento + impuesto + envío (el envío no lleva impuesto).
function computeOrderAmounts(lines, shipping, discount, taxRate = 0) {
  const cents = (n) => Math.round(Number(n) * 100);
  const subtotalC = lines.reduce((a, l) => a + cents(l.linePrice), 0);
  const shipC = cents(shipping), disc = cents(discount);
  if (disc > subtotalC + shipC) throw new BadRequest('El descuento no puede ser mayor que el total');
  const baseC = Math.max(0, subtotalC - disc);
  const taxC = Math.round(baseC * (Number(taxRate) || 0) / 100);
  const totalC = subtotalC - disc + taxC + shipC;
  if (totalC / 100 > MAX_MONEY) throw new BadRequest('El total es demasiado grande');
  return { subtotal: subtotalC / 100, tax: taxC / 100, total: totalC / 100 };
}
const computeOrderTotal = (lines, shipping, discount, taxRate = 0) => computeOrderAmounts(lines, shipping, discount, taxRate).total;

// Ajustes de impuesto y zonas del negocio (tenant_settings). Sin fila → impuesto apagado.
const DEFAULT_TAX = { enabled: false, rate: 0, label: 'IVA' };
function mapTax(v) {
  const t = v && typeof v === 'object' ? v : {};
  return { enabled: t.enabled === true, rate: Math.round((Number(t.rate) || 0) * 100) / 100, label: String(t.label || DEFAULT_TAX.label).slice(0, 30) };
}
async function getTenantTaxRate(db, tenantId) {
  const { rows } = await db.query('SELECT tax FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
  const t = mapTax(rows[0] && rows[0].tax);
  return t.enabled ? t.rate : 0;
}
// Fecha de entrega (YYYY-MM-DD real o null) y zona (texto ≤ 60 o null)
function cleanDeliveryDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!isRealDate(s) || Number(s.slice(0, 4)) < 2000 || Number(s.slice(0, 4)) > 2100) throw new BadRequest('Fecha de entrega inválida (formato AAAA-MM-DD)');
  return s;
}
function cleanDeliveryZone(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (s.length > 60) throw new BadRequest('La zona de entrega es demasiado larga (máx. 60 caracteres)');
  return s || null;
}

// Valida la lista de artículos de un pedido que llega por la API
const MAX_ORDER_ITEMS = 100;
function cleanOrderItems(items) {
  if (!Array.isArray(items)) throw new BadRequest('La lista de artículos no es válida');
  if (items.length > MAX_ORDER_ITEMS) throw new BadRequest(`Máximo ${MAX_ORDER_ITEMS} artículos por pedido`);
  const str = (v, max) => (v === undefined || v === null || v === '') ? null : String(v).slice(0, max);
  const money = (v) => { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) throw new BadRequest('Precio inválido'); return Math.round(n * 100) / 100; };
  return items.map(it => {
    if (!it || typeof it !== 'object') throw new BadRequest('Artículo inválido');
    const name = str(it.name, 200);
    if (!name) throw new BadRequest('Cada artículo necesita un nombre');
    const qty = Number(it.qty ?? 1);
    if (!Number.isInteger(qty) || qty < 1 || qty > 100000) throw new BadRequest('Cantidad inválida');
    const unitPrice = money(it.unitPrice ?? 0);
    // El subtotal siempre lo calcula el servidor (un linePrice enviado por el cliente se ignora)
    const linePrice = money(unitPrice * qty);
    if (linePrice > MAX_MONEY) throw new BadRequest('El total es demasiado grande');
    // Variante (talla × color): el SPA manda size/color; el servidor deriva la clave estable. Al reenviar un pedido
    // existente basta con variantKey (que el propio servidor devolvió).
    const variantKey = (it.size !== undefined || it.color !== undefined) ? ops.buildVariantKey(it.size, it.color) : ops.normVariantKey(it.variantKey);
    return {
      productId: UUID_RE.test(String(it.productId || '')) ? String(it.productId) : null,
      emoji: str(it.emoji, 16), name, detail: str(it.detail, 300), qty, unitPrice,
      linePrice, variantKey,
    };
  });
}

// ── Pagos (Fase 2) ────────────────────────────────────────────
// Un pedido se cobra con pagos (tabla payments, solo se añaden; un error se corrige anulando).
// orders.amount_paid / pay_status los deriva recalcOrderPayment (pagos.js) en la misma transacción.

const PAY_CURRENCY_RE = /^[A-Z]{3,5}$/;
const BASE_CURRENCIES = ['USD', 'VES', 'EUR', 'COP', 'MXN', 'PEN', 'CLP', 'ARS'];
const centsOf = (n) => Math.round(Number(n || 0) * 100);

// Ejecuta fn(client) en una transacción: COMMIT si termina, ROLLBACK si lanza
async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Respuesta de error de las rutas de pagos: datos mal enviados → 400; lo demás → 500 sin detalles internos
// Cuerpo del 400 de un BadRequest: «sin ubicación» lleva su código propio (location_required) para que el SPA lleve a Ajustes → Perfil → País y zona horaria
// Error de datos con código propio (el SPA reconoce el código, no el texto): 400 { error: code, message, ...extra }
class TeamError extends BadRequest { constructor(code, message, extra = {}) { super(message); this.errCode = code; this.extra = extra; } }
const badRequestBody = (err) => err instanceof TeamError ? { error: err.errCode, message: err.message, ...err.extra }
  : err instanceof ops.LocationRequired ? { error: 'location_required', message: err.message }
  : err instanceof ops.CashClosed ? { error: 'cash_closed', message: err.message } : { error: err.message };
function sendApiError(res, err, label) {
  if (err instanceof BadRequest) return res.status(400).json(badRequestBody(err));
  console.error(label + ':', err.message);
  return res.status(500).json({ error: 'No se pudo completar la operación' });
}

// createdBy = actor ({ id, role, name } de req.user) o 'owner' (sistema): ver operacion.js → actorText / actorId
const { actorText, actorId } = ops;
async function addOrderEvent(db, tenantId, orderId, type, data, createdBy = 'owner') {
  await db.query(
    'INSERT INTO order_events (tenant_id, order_id, type, data, created_by, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6)',
    [tenantId, orderId, type, JSON.stringify(data ?? null), actorText(createdBy), actorId(createdBy)]);
}

function mapPaymentRow(r) {
  const out = {
    id: r.id, orderId: r.order_id, clientId: r.client_id,
    amount: Number(r.amount), currency: r.currency, exchangeRate: Number(r.exchange_rate), amountBase: Number(r.amount_base),
    method: r.method, reference: r.reference, paidAt: r.paid_at, note: r.note,
    createdAt: r.created_at, createdBy: r.created_by, createdByUserId: r.created_by_user_id || null, voidedByUserId: r.voided_by_user_id || null,
    voided: !!r.voided_at, voidedAt: r.voided_at, voidReason: r.void_reason,
  };
  if (r.order_num !== undefined) {
    out.orderNumber = '#' + String(r.order_num).padStart(4, '0');
    out.clientName = r.client_name || null;
  }
  return out;
}

// Un pedido con sus artículos (mismo formato que la lista de pedidos)
async function fetchOrderFull(db, tenantId, orderId) {
  const { rows } = await db.query(`
    SELECT o.*,
      COALESCE(json_agg(json_build_object(
        'id', oi.id, 'productId', oi.product_id, 'emoji', oi.emoji, 'name', oi.name, 'detail', oi.detail,
        'qty', oi.qty, 'unitPrice', oi.unit_price, 'linePrice', oi.line_price, 'variantKey', COALESCE(oi.variant_key, ''))
      ) FILTER (WHERE oi.id IS NOT NULL), '[]'::json) AS items
    FROM orders o
    LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.tenant_id = o.tenant_id
    WHERE o.id = $1 AND o.tenant_id = $2
    GROUP BY o.id`, [orderId, tenantId]);
  return rows[0] ? ops.withName(db, tenantId, mapOrderRow(rows[0]), ops.BY_CREATED) : null;
}

// Zona horaria del negocio: SOLO la de su ubicación (país + zona, Ajustes → Perfil → País y zona horaria). Nunca la del navegador: el `tz` de la
// URL que aún mande un cliente antiguo se ignora. Sin ubicación → 400 { error: 'location_required' }.
async function resolveTenantTz(tenantId) {
  const { rows: [t] } = await pool.query('SELECT timezone, country FROM tenants WHERE id = $1', [tenantId]);
  return ops.requireTz(t);
}
// Ubicación para el SPA: país, zona efectiva (null si falta) y las zonas que admite su país
const locationOf = (t) => ({
  country: ops.canonCountry(t && t.country) || (t && t.country) || null,
  timezone: ops.tzOf(t),
  timezoneOptions: ops.timezonesForCountry(t && t.country),
});

// Rellena la zona horaria de los negocios con país: la de por defecto de su país si falta o no es de ese país.
// «Otro» y sin país no se tocan. Idempotente y barato (tenants es una tabla pequeña); corre en cada arranque.
async function backfillTenantTimezones() {
  const { rows } = await pool.query('SELECT DISTINCT country FROM tenants WHERE country IS NOT NULL');
  const byCanon = new Map();
  for (const r of rows) {
    const c = ops.canonCountry(r.country);
    if (!c || !ops.defaultTimezoneFor(c)) continue;
    if (!byCanon.has(c)) byCanon.set(c, []);
    byCanon.get(c).push(r.country);
  }
  let n = 0;
  for (const [c, raws] of byCanon) {
    const { rowCount } = await pool.query(
      'UPDATE tenants SET timezone = $1 WHERE country = ANY($2::text[]) AND (timezone IS NULL OR timezone <> ALL($3::text[]))',
      [ops.defaultTimezoneFor(c), raws, ops.timezonesForCountry(c)]);
    n += rowCount;
  }
  if (n) console.log(`✅ Zona horaria: ${n} negocio(s) ajustados a la de su país`);
}

const isRealDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 10) === s;
const payNum = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN;
const payStr = (v, max, label, required) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s) { if (required) throw new BadRequest(label + ' obligatorio'); return null; }
  if (s.length > max) throw new BadRequest(`${label} demasiado largo (máx. ${max} caracteres)`);
  return s;
};

// Saldo a favor de un cliente, en centavos, bloqueando antes su ficha (FOR NO KEY UPDATE: dos gastos de saldo se esperan, pero
// un alta de pedido de ese cliente —que solo toma FOR KEY SHARE por la clave foránea— no queda esperando): dentro de una
// transacción que ya tiene bloqueado el pedido Y el tenant (orden: pedido → tenant → cliente → existencias). Nunca negativo.
async function lockedClientCreditC(db, tenantId, clientId) {
  const { rows: lk } = await db.query('SELECT 1 FROM clients WHERE id = $1 AND tenant_id = $2 FOR NO KEY UPDATE', [clientId, tenantId]);
  if (!lk[0]) throw new BadRequest('Cliente no encontrado');
  const { rows: [r] } = await db.query('SELECT COALESCE(SUM(amount), 0) AS b FROM client_credit_entries WHERE client_id = $1 AND tenant_id = $2', [clientId, tenantId]);
  return centsOf(r.b);
}

// Registra un pago (DENTRO de una transacción). Bloquea la fila del pedido para que dos pagos
// simultáneos no superen el saldo. Devuelve { payment, order (fila ya recalculada) } o null si no existe.
async function addPaymentTx(db, tenantId, orderId, body, createdBy = 'owner') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Datos del pago inválidos');
  const { rows: ord } = await db.query('SELECT * FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [orderId, tenantId]);
  if (!ord[0]) return null;
  if (ord[0].kind === 'quote') throw new BadRequest('Un presupuesto no admite cobros: conviértelo en pedido primero');
  if (ord[0].delivery_status === 'cancelled') throw new BadRequest('El pedido está anulado: no admite cobros');
  // Orden de bloqueo: pedido → tenant (SHARE: un cambio de moneda base o un cierre de caja, FOR UPDATE, espera a que termine
  // este pago, y viceversa) → cliente. Ver operacion.js.
  const t = await ops.lockTenantForCash(db, tenantId, 'SHARE');
  const base = t.base_currency || 'USD';

  // Total EFECTIVO: el total del pedido menos sus notas de crédito. amount_paid ya es el cobrado neto.
  const totalC = centsOf(ord[0].total_price) - centsOf(ord[0].credited_total), balanceC = totalC - centsOf(ord[0].amount_paid);
  // full: true → se cobra el saldo completo que calcula el servidor (el amount enviado se ignora)
  if (body.full !== undefined && typeof body.full !== 'boolean') throw new BadRequest('"full" debe ser verdadero o falso');
  const full = body.full === true;
  if (full) {
    if (totalC <= 0) throw new BadRequest('El pedido no tiene monto por cobrar');
    if (balanceC <= 0) throw new BadRequest('El pedido ya está pagado por completo');
  }
  let amountR;
  if (!full) {
    const amount = payNum(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_MONEY) throw new BadRequest('Monto inválido');
    amountR = Math.round(amount * 100) / 100;
    if (amountR <= 0) throw new BadRequest('Monto inválido');
  }
  const currency = body.currency === undefined || body.currency === null || body.currency === '' ? base : String(body.currency).trim().toUpperCase();
  if (!PAY_CURRENCY_RE.test(currency)) throw new BadRequest('Moneda inválida');
  const foreign = currency !== base;
  let rate = 1, amountBaseC = full ? balanceC : centsOf(amountR);
  if (foreign) {
    rate = payNum(body.exchangeRate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1e9) throw new BadRequest('Indica la tasa de cambio (mayor que 0)');
    rate = Math.round(rate * 1e6) / 1e6;
    if (rate <= 0) throw new BadRequest('Indica la tasa de cambio (mayor que 0)');
    if (full) {
      amountR = Math.round(balanceC / 100 * rate * 100) / 100; // el saldo, expresado en la moneda del pago
      if (!(amountR > 0) || amountR > MAX_MONEY) throw new BadRequest('Tasa de cambio fuera de rango');
    } else amountBaseC = Math.round(amountR / rate * 100);
    if (amountBaseC < 1) throw new BadRequest('El monto es demasiado pequeño para esa tasa');
  } else if (full) amountR = balanceC / 100;
  let method = payStr(body.method, 60, 'Método de pago', true);
  const withCredit = isCreditMethod(method);
  if (withCredit) method = CREDIT_METHOD;
  const reference = payStr(body.reference, 80, 'Referencia', false);
  const note = payStr(body.note, 300, 'Nota', false);

  let paidAt = null;
  if (body.paidAt !== undefined && body.paidAt !== null && body.paidAt !== '') {
    const raw = String(body.paidAt).trim();
    const tz = ops.tzOf(t);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      // Una fecha sin hora necesita la zona del negocio; sin ubicación se rechaza (un pago «de ahora», sin fecha, sí se admite)
      if (!tz) throw new ops.LocationRequired(ops.LOCATION_MSG);
      if (!isRealDate(raw)) throw new BadRequest('Fecha del pago inválida');
      // Fecha sin hora: mediodía en la zona del negocio (así cae en el día correcto en los informes)
      paidAt = (await db.query(`SELECT (($1::date + time '12:00') AT TIME ZONE $2) AS ts`, [raw, tz])).rows[0].ts;
    } else {
      paidAt = new Date(raw);
      if (isNaN(paidAt.getTime())) throw new BadRequest('Fecha del pago inválida');
    }
    // Futura = posterior al día de hoy DEL NEGOCIO (sin ubicación y con hora: tolerancia de un día, no hay día que comparar)
    if (tz ? (await ops.businessDay(db, tz, paidAt)) > (await ops.businessDay(db, tz)) : paidAt.getTime() > Date.now() + 86400000) {
      throw new BadRequest('La fecha del pago no puede ser futura');
    }
    if (paidAt.getFullYear() < 2000) throw new BadRequest('Fecha del pago inválida');
  }

  if (totalC <= 0) throw new BadRequest('El pedido no tiene monto por cobrar');
  if (balanceC <= 0) throw new BadRequest('El pedido ya está pagado por completo');
  if (amountBaseC > balanceC) {
    // En otra moneda el redondeo puede dejar un centavo de más al cobrar el saldo exacto: se ajusta al saldo
    if (foreign && amountBaseC - balanceC <= 1) amountBaseC = balanceC;
    else throw new BadRequest(`El pago supera el saldo pendiente (${(balanceC / 100).toFixed(2)} ${base})`);
  }

  if (withCredit) {
    // Saldo a favor: solo en la moneda base, de un cliente del pedido y sin pasarse de lo que tiene. La fila del
    // cliente se bloquea (siempre DESPUÉS de la del pedido), así dos pagos simultáneos no gastan el mismo saldo.
    if (foreign) throw new BadRequest('El saldo a favor se usa en la moneda base');
    if (!ord[0].client_id) throw new BadRequest('El pedido no tiene cliente: el saldo a favor es de un cliente');
    const credit = await lockedClientCreditC(db, tenantId, ord[0].client_id);
    if (amountBaseC > credit) throw new BadRequest(`El cliente solo tiene ${(credit / 100).toFixed(2)} ${base} de saldo a favor`);
  }
  // Caja cerrada: no se registran pagos en un día cerrado (comprobado aquí dentro, con el tenant bloqueado).
  // El saldo a favor no mueve la caja.
  if (!withCredit) await ops.assertCashOpen(db, tenantId, { instants: [paidAt] });
  const { rows } = await db.query(`
    INSERT INTO payments (tenant_id, order_id, client_id, amount, currency, exchange_rate, amount_base,
                          method, reference, paid_at, note, created_by, created_by_user_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10::timestamptz, now()), $11, $12, $13) RETURNING *
  `, [tenantId, orderId, ord[0].client_id, amountR, currency, rate, amountBaseC / 100, method, reference, paidAt, note, actorText(createdBy), actorId(createdBy)]);
  if (withCredit) {
    await db.query(`INSERT INTO client_credit_entries (tenant_id, client_id, amount, kind, order_id, ref_id)
      VALUES ($1, $2, $3, 'credit_payment', $4, $5)`, [tenantId, ord[0].client_id, -amountBaseC / 100, orderId, rows[0].id]);
  }
  await addOrderEvent(db, tenantId, orderId, 'payment_added', {
    paymentId: rows[0].id, amount: amountR, currency, amountBase: amountBaseC / 100, method, reference }, createdBy);
  const order = await recalcOrderPayment(db, tenantId, orderId);
  return { payment: mapPaymentRow(rows[0]), order };
}

// Anula un pago (DENTRO de una transacción). Devuelve null si no existe en este negocio.
async function voidPaymentTx(db, tenantId, paymentId, reason, createdBy = 'owner') {
  const why = payStr(reason, 200, 'Motivo', true);
  const { rows: pr } = await db.query('SELECT order_id, paid_at, method FROM payments WHERE id = $1 AND tenant_id = $2', [paymentId, tenantId]);
  if (!pr[0]) return null;
  // Mismo orden de bloqueo que addPaymentTx: primero el pedido (y después el cliente, si el pago fue con saldo a favor)
  const { rows: [ord] } = await db.query('SELECT client_id FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [pr[0].order_id, tenantId]);
  // Caja cerrada: no se anulan pagos de un día cerrado (el día del pago, no el de hoy)
  if (!isCreditMethod(pr[0].method)) await ops.assertCashOpen(db, tenantId, { instants: [pr[0].paid_at] });
  const { rows } = await db.query(
    'UPDATE payments SET voided_at = now(), void_reason = $3, voided_by_user_id = $4 WHERE id = $1 AND tenant_id = $2 AND voided_at IS NULL RETURNING *',
    [paymentId, tenantId, why, actorId(createdBy)]);
  if (!rows[0]) throw new BadRequest('Este pago ya fue anulado');
  // Lo cobrado neto (pagos − reembolsos) no puede quedar negativo: un pago ya devuelto no se anula (se corrige con una operación nueva)
  const { rows: [net] } = await db.query(`SELECT
      (SELECT COALESCE(SUM(amount_base), 0) FROM payments WHERE order_id = $1 AND tenant_id = $2 AND voided_at IS NULL) -
      (SELECT COALESCE(SUM(amount_base), 0) FROM refunds  WHERE order_id = $1 AND tenant_id = $2) AS n`, [rows[0].order_id, tenantId]);
  if (centsOf(net.n) < 0) throw new BadRequest('Este pago ya fue devuelto al cliente (reembolso o saldo a favor): no se puede anular');
  if (isCreditMethod(rows[0].method)) {
    // Pagó con saldo a favor: se le devuelve
    const clientId = rows[0].client_id || (ord && ord.client_id);
    if (!clientId) throw new BadRequest('El cliente de este pago ya no existe: no se puede devolver el saldo a favor');
    await lockedClientCreditC(db, tenantId, clientId);
    await db.query(`INSERT INTO client_credit_entries (tenant_id, client_id, amount, kind, order_id, ref_id)
      VALUES ($1, $2, $3, 'credit_payment_void', $4, $5)`, [tenantId, clientId, Number(rows[0].amount_base), rows[0].order_id, paymentId]);
  }
  await addOrderEvent(db, tenantId, rows[0].order_id, 'payment_voided', {
    paymentId, amountBase: Number(rows[0].amount_base), method: rows[0].method, reason: why }, createdBy);
  const order = await recalcOrderPayment(db, tenantId, rows[0].order_id);
  return { payment: mapPaymentRow(rows[0]), order };
}

// ── Fase 3: devoluciones, reembolsos, saldo a favor, anulación y conversión de presupuestos ──
// Reglas (no romper): el dinero no se edita, se registra. Notas de crédito y reembolsos solo se añaden (esta
// fase NO los anula: un error se corrige con una operación nueva). Orden de bloqueo SIEMPRE: pedido → tenant
// (contadores) → cliente. Todo dentro de la transacción de quien llama.

const MAX_CREDIT_NOTES_PER_ORDER = 200;
const cleanResolution = (v) => {
  if (v !== 'refund' && v !== 'credit') throw new BadRequest('Indica si el dinero se reembolsa o queda como saldo a favor del cliente');
  return v;
};
const fmtCreditNote = (n) => 'NC-' + pad4(n);

function mapRefundRow(r) {
  return {
    id: r.id, orderId: r.order_id, creditNoteId: r.credit_note_id,
    amount: Number(r.amount), currency: r.currency, exchangeRate: Number(r.exchange_rate), amountBase: Number(r.amount_base),
    method: r.method, reference: r.reference, reason: r.reason, createdAt: r.created_at, createdBy: r.created_by,
    createdByUserId: r.created_by_user_id || null,
  };
}

// Reembolsa `amountC` centavos de un pedido (DENTRO de una transacción, con el pedido ya bloqueado y `ord` recién
// recalculado). 'refund' → con el método elegido (lo que se cobró con saldo a favor vuelve al saldo del cliente,
// no sale como efectivo); 'credit' → todo al saldo a favor. Devuelve las filas de refunds creadas.
async function settleRefundTx(db, tenantId, ord, amountC, o) {
  if (amountC <= 0) return [];
  // Orden de bloqueo: pedido (ya tomado) → tenant → cliente → existencias. El tenant va primero (FOR KEY SHARE).
  const tenantRow = await ops.lockTenantForCash(db, tenantId, 'SHARE');
  let method = null;
  if (o.resolution === 'refund') {
    method = payStr(o.method, 60, 'Método de reembolso', true);
    if (isCreditMethod(method)) throw new BadRequest('Para dejar el dinero como saldo a favor elige esa opción, no un método de reembolso');
    method = normalizeMethodName(method);
    // Decisión: el método de reembolso es libre (puede no coincidir con el del cobro: se cobró por Zelle y se devuelve en
    // efectivo). Solo se limita el IMPORTE (nunca más de lo cobrado neto). El informe lo muestra tal cual: un método sin
    // cobros sale en negativo en «cobros por método», que es lo que pasó con el dinero de esa caja.
  }
  const { rows: [sp] } = await db.query(`SELECT
      (SELECT COALESCE(SUM(amount_base), 0) FROM payments WHERE order_id = $1 AND tenant_id = $2 AND voided_at IS NULL AND method = $3) AS pay_credit,
      (SELECT COALESCE(SUM(amount_base), 0) FROM refunds  WHERE order_id = $1 AND tenant_id = $2 AND method = $3) AS ref_credit`,
    [ord.id, tenantId, CREDIT_METHOD]);
  const creditNetC = Math.max(0, centsOf(sp.pay_credit) - centsOf(sp.ref_credit));
  const cashNetC = Math.max(0, centsOf(ord.amount_paid) - creditNetC);
  const cashC = o.resolution === 'refund' ? Math.min(amountC, cashNetC) : 0;
  const creditC = amountC - cashC;
  // Defensa: el saldo a favor vuelve a la ficha que pagó con él (PATCH ya impide cambiar de cliente a un pedido así)
  let creditClientId = ord.client_id;
  if (creditC > 0) {
    const { rows: payers } = await db.query(
      'SELECT DISTINCT client_id FROM payments WHERE order_id = $1 AND tenant_id = $2 AND voided_at IS NULL AND method = $3 AND client_id IS NOT NULL',
      [ord.id, tenantId, CREDIT_METHOD]);
    if (payers.length === 1) creditClientId = payers[0].client_id;
    if (!creditClientId) throw new BadRequest('El pedido no tiene cliente: no se puede dejar saldo a favor');
    await lockedClientCreditC(db, tenantId, creditClientId);
  }
  // Caja cerrada: un reembolso en efectivo/transferencia mueve la caja de HOY (el saldo a favor, no)
  if (cashC > 0) await ops.assertCashOpen(db, tenantId, { instants: [null] });
  const base = tenantRow.base_currency || 'USD';
  const out = [];
  for (const [c, m] of [[cashC, method], [creditC, CREDIT_METHOD]]) {
    if (c <= 0) continue;
    const { rows } = await db.query(`
      INSERT INTO refunds (tenant_id, order_id, credit_note_id, amount, currency, exchange_rate, amount_base, method, reason, created_by, created_by_user_id)
      VALUES ($1, $2, $3, $4, $5, 1, $4, $6, $7, $8, $9) RETURNING *`,
      [tenantId, ord.id, o.creditNoteId || null, c / 100, base, m, o.reason, actorText(o.createdBy), actorId(o.createdBy)]);
    if (m === CREDIT_METHOD) {
      await db.query(`INSERT INTO client_credit_entries (tenant_id, client_id, amount, kind, order_id, ref_id)
        VALUES ($1, $2, $3, 'refund_to_credit', $4, $5)`, [tenantId, creditClientId, c / 100, ord.id, rows[0].id]);
    }
    await addOrderEvent(db, tenantId, ord.id, 'refunded', {
      refundId: rows[0].id, amountBase: c / 100, method: m, creditNoteId: o.creditNoteId || null, reason: o.reason }, o.createdBy);
    out.push(rows[0]);
  }
  return out;
}

// Parte del total (con su descuento y su impuesto) que corresponde a `units` unidades de un artículo
function itemShareC(it, ord, subtotalC, units) {
  const lineC = Math.round(centsOf(it.line_price) * units / Math.max(1, Number(it.qty)));
  const discC = subtotalC > 0 ? Math.min(lineC, Math.round(centsOf(ord.discount) * lineC / subtotalC)) : 0;
  const baseC = lineC - discC;
  return baseC + Math.round(baseC * Number(ord.tax_rate || 0) / 100);
}

async function mapCreditNoteFull(db, tenantId, noteRows) {
  if (!noteRows.length) return [];
  const ids = noteRows.map(n => n.id);
  const [items, refs] = await Promise.all([
    db.query('SELECT * FROM credit_note_items WHERE tenant_id = $1 AND credit_note_id = ANY($2::uuid[]) ORDER BY ctid', [tenantId, ids]),
    db.query('SELECT * FROM refunds WHERE tenant_id = $1 AND order_id = ANY($3::uuid[]) AND credit_note_id = ANY($2::uuid[]) ORDER BY created_at',
      [tenantId, ids, [...new Set(noteRows.map(n => n.order_id))]]),
  ]);
  return noteRows.map(n => ({
    id: n.id, orderId: n.order_id, clientId: n.client_id, number: fmtCreditNote(n.number),
    amountBase: Number(n.amount_base), reason: n.reason, createdAt: n.created_at, createdBy: n.created_by, createdByUserId: n.created_by_user_id || null,
    items: items.rows.filter(i => i.credit_note_id === n.id).map(i => ({
      id: i.id, orderItemId: i.order_item_id, name: i.name, qty: i.qty, amount: Number(i.amount) })),
    refunds: refs.rows.filter(r => r.credit_note_id === n.id).map(mapRefundRow),
  }));
}

// Devolución: nota de crédito + (si ya se había cobrado de más) el reembolso o saldo a favor, todo en UNA transacción.
async function createReturnTx(db, tenantId, orderId, body, createdBy = 'owner') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Datos de la devolución inválidos');
  const reason = payStr(body.reason, 300, 'Motivo', true);
  const resolution = cleanResolution(body.resolution);
  const hasItems = body.items !== undefined && body.items !== null;
  const hasAmount = body.amount !== undefined && body.amount !== null && body.amount !== '';
  if (hasItems === hasAmount) throw new BadRequest('Indica los artículos devueltos o un importe (solo uno de los dos)');
  const { rows: [ord0] } = await db.query('SELECT * FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [orderId, tenantId]);
  if (!ord0) return null;
  if (ord0.kind === 'quote') throw new BadRequest('Un presupuesto no admite devoluciones');
  if (ord0.delivery_status === 'cancelled') throw new BadRequest('El pedido está anulado: no admite devoluciones');
  if (resolution === 'credit' && !ord0.client_id) throw new BadRequest('El pedido no tiene cliente: no se puede dejar saldo a favor');
  // Tope por pedido: la ficha del pedido carga sus notas de una vez (y los pedidos reales no necesitan cientos)
  const { rows: [nn] } = await db.query('SELECT COUNT(*)::int AS n FROM credit_notes WHERE order_id = $1 AND tenant_id = $2', [orderId, tenantId]);
  if (nn.n >= MAX_CREDIT_NOTES_PER_ORDER) throw new BadRequest(`Este pedido ya tiene ${MAX_CREDIT_NOTES_PER_ORDER} devoluciones: no admite más`);
  const { rows: [bt] } = await db.query('SELECT base_currency FROM tenants WHERE id = $1', [tenantId]);
  const base = (bt && bt.base_currency) || 'USD';
  const effectiveC = centsOf(ord0.total_price) - centsOf(ord0.credited_total);

  let amountC = 0, lines = [];
  if (hasItems) {
    if (!Array.isArray(body.items) || !body.items.length) throw new BadRequest('Indica al menos un artículo devuelto');
    if (body.items.length > MAX_ORDER_ITEMS) throw new BadRequest('Demasiados artículos');
    const want = new Map();
    for (const it of body.items) {
      if (!it || typeof it !== 'object') throw new BadRequest('Artículo inválido');
      const id = String(it.orderItemId || '');
      if (!UUID_RE.test(id)) throw new BadRequest('Artículo no encontrado en este pedido');
      const qty = Number(it.qty);
      if (!Number.isInteger(qty) || qty < 1 || qty > 100000) throw new BadRequest('Cantidad devuelta inválida');
      want.set(id, (want.get(id) || 0) + qty);
    }
    const { rows: oi } = await db.query('SELECT * FROM order_items WHERE order_id = $1 AND tenant_id = $2', [orderId, tenantId]);
    const byId = new Map(oi.map(r => [r.id, r]));
    const { rows: ret } = await db.query(`
      SELECT cni.order_item_id, SUM(cni.qty)::int AS n FROM credit_note_items cni
      JOIN credit_notes cn ON cn.id = cni.credit_note_id AND cn.tenant_id = cni.tenant_id
      WHERE cn.order_id = $1 AND cn.tenant_id = $2 AND cni.order_item_id IS NOT NULL GROUP BY cni.order_item_id`, [orderId, tenantId]);
    const returned = new Map(ret.map(r => [r.order_item_id, r.n]));
    // Devoluciones por importe previas: se descuentan primero del envío (así se devuelve el envío por importe)
    const { rows: [ba] } = await db.query(`
      SELECT COALESCE(SUM(cni.amount), 0) AS n FROM credit_note_items cni
      JOIN credit_notes cn ON cn.id = cni.credit_note_id AND cn.tenant_id = cni.tenant_id
      WHERE cn.order_id = $1 AND cn.tenant_id = $2 AND cni.order_item_id IS NULL`, [orderId, tenantId]);
    const subtotalC = oi.reduce((a, r) => a + centsOf(r.line_price), 0);
    for (const [id, qty] of want) {
      const it = byId.get(id);
      if (!it) throw new BadRequest('Artículo no encontrado en este pedido');
      const before = returned.get(id) || 0;
      if (before + qty > Number(it.qty)) {
        throw new BadRequest(`No se pueden devolver ${qty} unidad(es) de «${it.name}»: se vendieron ${it.qty} y ya se devolvieron ${before}`);
      }
      const amtC = itemShareC(it, ord0, subtotalC, before + qty) - itemShareC(it, ord0, subtotalC, before);
      amountC += amtC;
      lines.push({ orderItemId: id, name: String(it.name || 'Artículo').slice(0, 200), qty, amountC: amtC });
    }
    // Lo que queda por devolver de los ARTÍCULOS = total efectivo − lo que aún queda de envío. Con los redondeos de
    // descuento e impuesto por línea, la suma de partes puede diferir en céntimos: la última devolución (sin
    // unidades por devolver) toma EXACTAMENTE lo que queda y una intermedia nunca lo supera.
    const shippingLeftC = Math.max(0, centsOf(ord0.shipping) - centsOf(ba.n));
    const itemsLeftC = Math.max(0, effectiveC - shippingLeftC);
    const allBack = oi.every(r => (returned.get(r.id) || 0) + (want.get(r.id) || 0) >= Number(r.qty));
    const target = allBack ? itemsLeftC : Math.min(amountC, itemsLeftC);
    if (target > amountC) lines[lines.length - 1].amountC += target - amountC;
    else {
      let cut = amountC - target; // se resta de las últimas líneas hacia atrás (ninguna queda negativa)
      for (let i = lines.length - 1; i >= 0 && cut > 0; i--) { const d = Math.min(cut, lines[i].amountC); lines[i].amountC -= d; cut -= d; }
    }
    amountC = target;
  } else {
    const amount = payNum(body.amount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_MONEY) throw new BadRequest('Importe de la devolución inválido');
    amountC = centsOf(amount);
    if (amountC <= 0) throw new BadRequest('Importe de la devolución inválido');
    lines = [{ orderItemId: null, name: 'Devolución por importe', qty: 1, amountC }];
  }
  if (amountC <= 0) throw new BadRequest('La devolución no tiene importe');
  if (amountC > effectiveC) throw new BadRequest(`La devolución supera lo que queda del pedido (${(effectiveC / 100).toFixed(2)} ${base})`);

  const { rows: [sq] } = await db.query(`
    UPDATE tenants SET credit_note_seq = GREATEST(credit_note_seq,
      COALESCE((SELECT MAX(number) FROM credit_notes WHERE tenant_id = $1), 0)) + 1
    WHERE id = $1 RETURNING credit_note_seq AS seq`, [tenantId]);
  const { rows: [note] } = await db.query(`
    INSERT INTO credit_notes (tenant_id, order_id, client_id, number, amount_base, reason, created_by, created_by_user_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [tenantId, orderId, ord0.client_id, sq.seq, amountC / 100, reason, actorText(createdBy), actorId(createdBy)]);
  for (const l of lines) {
    await db.query(`INSERT INTO credit_note_items (tenant_id, credit_note_id, order_item_id, name, qty, amount)
      VALUES ($1, $2, $3, $4, $5, $6)`, [tenantId, note.id, l.orderItemId, l.name, l.qty, l.amountC / 100]);
  }
  const ord = await recalcOrderPayment(db, tenantId, orderId);
  await addOrderEvent(db, tenantId, orderId, 'returned', {
    creditNoteId: note.id, number: fmtCreditNote(note.number), amountBase: amountC / 100, reason, resolution,
    items: lines.map(l => ({ name: l.name, qty: l.qty })) }, createdBy);
  // Si ya estaba cobrado más de lo que ahora vale el pedido, el exceso (hasta el importe de la nota) se resuelve ya
  const excessC = Math.max(0, centsOf(ord.amount_paid) - (centsOf(ord.total_price) - centsOf(ord.credited_total)));
  const refunds = await settleRefundTx(db, tenantId, ord, Math.min(excessC, amountC), {
    resolution, method: body.refundMethod, reason, creditNoteId: note.id, createdBy });
  // Devolución por artículos: las unidades vuelven al almacén (una devolución por importe no mueve existencias).
  // Va al final: el orden de bloqueo es pedido → tenant → cliente → existencias.
  if (hasItems) await ops.restoreReturnedStock(db, tenantId, orderId,
    lines.filter(l => l.orderItemId).map(l => ({ orderItemId: l.orderItemId, qty: l.qty })), fmtCreditNote(note.number), createdBy);
  const order = refunds.length ? await recalcOrderPayment(db, tenantId, orderId) : ord;
  const [full] = await mapCreditNoteFull(db, tenantId, [note]);
  return { creditNote: full, order };
}

// Anula un pedido (o un presupuesto). Lo cobrado neto se devuelve en la misma transacción.
async function cancelOrderTx(db, tenantId, orderId, body, createdBy = 'owner') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Datos de la anulación inválidos');
  const reason = payStr(body.reason, 300, 'Motivo', true);
  const { rows: [ord] } = await db.query('SELECT * FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [orderId, tenantId]);
  if (!ord) return null;
  if (ord.delivery_status === 'cancelled') throw new BadRequest('El pedido ya está anulado');
  const paidC = ord.kind === 'quote' ? 0 : centsOf(ord.amount_paid);
  const noRes = body.resolution === undefined || body.resolution === null || body.resolution === '';
  const resolution = noRes ? (paidC > 0 ? cleanResolution(body.resolution) : null) : cleanResolution(body.resolution);
  if (resolution === 'credit' && !ord.client_id) throw new BadRequest('El pedido no tiene cliente: no se puede dejar saldo a favor');
  const refunds = await settleRefundTx(db, tenantId, ord, paidC, { resolution, method: body.refundMethod, reason, creditNoteId: null, createdBy });
  // Existencias: vuelve lo que el pedido aún tenía descontado (lo ya devuelto por artículos no se cuenta dos veces)
  if (ord.kind === 'order') await ops.syncOrderStock(db, tenantId, orderId, [], 'cancel', createdBy);
  await db.query(`UPDATE orders SET delivery_status = 'cancelled', cancelled_at = now(), cancel_reason = $3, updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2`, [orderId, tenantId, reason]);
  await addOrderEvent(db, tenantId, orderId, 'cancelled', {
    reason, from: ord.delivery_status, resolution, refundedBase: refunds.reduce((a, r) => a + Number(r.amount_base), 0) }, createdBy);
  return refunds.length ? await recalcOrderPayment(db, tenantId, orderId)
    : (await db.query('SELECT * FROM orders WHERE id = $1 AND tenant_id = $2', [orderId, tenantId])).rows[0];
}

// Convierte un presupuesto en pedido: recibe el siguiente número de pedido (#0001…) y cuenta desde hoy
async function convertQuoteTx(db, tenantId, orderId, createdBy = 'owner') {
  const { rows: [ord] } = await db.query('SELECT * FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [orderId, tenantId]);
  if (!ord) return null;
  if (ord.kind !== 'quote') throw new BadRequest('Este documento ya es un pedido');
  if (ord.delivery_status === 'cancelled') throw new BadRequest('El presupuesto está anulado: no se puede convertir');
  const { rows: [sq] } = await db.query(`
    UPDATE tenants SET order_seq = GREATEST(order_seq,
      COALESCE((SELECT MAX(tenant_order_number) FROM orders WHERE tenant_id = $1), 0)) + 1
    WHERE id = $1 RETURNING order_seq AS seq`, [tenantId]);
  await db.query(`UPDATE orders SET kind = 'order', tenant_order_number = $3, created_at = NOW(), updated_at = NOW()
    WHERE id = $1 AND tenant_id = $2`, [orderId, tenantId, sq.seq]);
  // Vender es convertir: aquí se toma la foto del costo y se descuentan las existencias
  await db.query(`UPDATE order_items oi SET unit_cost = cp.cost FROM catalog_products cp
    WHERE oi.order_id = $1 AND oi.tenant_id = $2 AND cp.id = oi.product_id AND cp.tenant_id = $2`, [orderId, tenantId]);
  const { rows: qLines } = await db.query('SELECT product_id, variant_key, qty FROM order_items WHERE order_id = $1 AND tenant_id = $2', [orderId, tenantId]);
  await ops.syncOrderStock(db, tenantId, orderId, qLines.map(l => ({ productId: l.product_id, variantKey: l.variant_key || '', qty: l.qty })), 'sale', createdBy);
  await addOrderEvent(db, tenantId, orderId, 'converted', {
    quote: 'P-' + pad4(ord.quote_number || 0), order: '#' + pad4(sq.seq), quoteCreatedAt: ord.created_at }, createdBy);
  return true;
}

// Actualiza un pedido (campos en snake_case). Con `items` reemplaza todos sus artículos;
// con `client_id` lo pasa a otra ficha del mismo negocio (null = sin ficha). Todo o nada.
async function dbUpdateOrder(tenantId, orderId, fields, actor = null) {
  if (!dbReady) return null;
  if (!UUID_RE.test(String(orderId))) return null;
  // El estado de cobro lo derivan los pagos (POST /api/orders/:id/payments): ya no se acepta por aquí
  if (fields.pay_status !== undefined) throw new BadRequest('Recarga la página: el cobro ahora se registra con «Registrar pago»');
  const allowed = ['delivery_status', 'pay_method_label', 'delivery_method_label',
    'address', 'notes', 'client_name', 'product_summary', 'total_price', 'shipping', 'discount', 'delivery_date', 'delivery_zone'];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: found } = await client.query('SELECT * FROM orders WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [orderId, tenantId]);
    if (!found[0]) { await client.query('ROLLBACK'); return null; }
    if (found[0].delivery_status === 'cancelled') throw new BadRequest('El pedido está anulado: ya no se puede modificar');
    // Un pedido ENTREGADO no se edita (artículos, importes, cliente, notas…): solo se puede cambiar su estado de entrega
    // (por ejemplo para corregir un «entregado» por error y editarlo después).
    if (found[0].delivery_status === 'delivered' &&
        Object.keys(fields).some(k => k !== 'delivery_status' && (allowed.includes(k) || k === 'client_id' || k === 'items'))) {
      throw new BadRequest('Este pedido ya fue entregado: no se puede editar');
    }
    const hasCredit = Number(found[0].credited_total || 0) > 0;
    if (hasCredit && fields.items !== undefined) throw new BadRequest('Este pedido tiene devoluciones: no se pueden cambiar sus artículos');

    const sets = [];
    const values = [];
    let newShipping, newDiscount, sentTotal;
    const FIELD_LABELS = { delivery_status: 'Estado de entrega', total_price: 'Total', shipping: 'Costo de envío', discount: 'Descuento' };
    const ENUMS = { delivery_status: DELIVERY_STATUSES };
    for (const [key, raw] of Object.entries(fields)) {
      if (!allowed.includes(key)) continue;
      let val = raw;
      if (key === 'delivery_status' && raw === 'cancelled') throw new BadRequest('Para anular un pedido usa «Anular pedido» (indica el motivo y qué pasa con el dinero)');
      if (ENUMS[key] && !ENUMS[key].includes(val)) throw new BadRequest(FIELD_LABELS[key] + ' inválido');
      if (key === 'delivery_date') val = cleanDeliveryDate(raw);
      else if (key === 'delivery_zone') val = cleanDeliveryZone(raw);
      else if (key === 'total_price' || key === 'shipping' || key === 'discount') {
        val = cleanMoneyField(raw, FIELD_LABELS[key]);
        if (hasCredit && key !== 'total_price' && centsOf(val) !== centsOf(found[0][key])) throw new BadRequest('Este pedido tiene devoluciones: no se puede cambiar el envío ni el descuento');
        if (key === 'shipping') newShipping = val;
        if (key === 'discount') newDiscount = val;
        // El total se decide más abajo: con artículos lo calcula el servidor
        if (key === 'total_price') { sentTotal = val; continue; }
      } else if (!ENUMS[key] && val !== null && val !== undefined) {
        val = String(val).slice(0, key === 'notes' || key === 'address' ? 2000 : 300);
      }
      values.push(val);
      sets.push(`${key} = $${values.length}`);
    }
    if (fields.client_id !== undefined) {
      let clientId = null;
      if (fields.client_id !== null) {
        const { rows } = await client.query('SELECT id FROM clients WHERE id::text = $1 AND tenant_id = $2', [String(fields.client_id), tenantId]);
        if (!rows[0]) throw new BadRequest('Cliente no encontrado');
        clientId = rows[0].id;
      }
      if (clientId !== found[0].client_id) {
        // El saldo a favor y las notas de crédito pertenecen al cliente del pedido: cambiarlo dejaría el dinero en la ficha equivocada
        const { rows: pm } = await client.query('SELECT DISTINCT method FROM payments WHERE order_id = $1 AND tenant_id = $2 AND voided_at IS NULL', [orderId, tenantId]);
        const { rows: [mv] } = await client.query(`SELECT
            EXISTS (SELECT 1 FROM credit_notes WHERE order_id = $1 AND tenant_id = $2) AS has_notes,
            EXISTS (SELECT 1 FROM client_credit_entries WHERE order_id = $1 AND tenant_id = $2) AS has_credit`, [orderId, tenantId]);
        if (pm.some(r => isCreditMethod(r.method)) || mv.has_notes || mv.has_credit) {
          throw new BadRequest('Este pedido tiene saldo a favor o devoluciones registradas a nombre de su cliente: no se puede cambiar de cliente');
        }
      }
      values.push(clientId);
      sets.push(`client_id = $${values.length}`);
    }
    const items = fields.items !== undefined ? cleanOrderItems(fields.items) : null;
    // Total: con artículos = Σ subtotales + envío − descuento (valores nuevos + guardados). Un total
    // enviado se ignora si el pedido tiene artículos (pedidos antiguos sin artículos lo conservan).
    let lines = items;
    if (!lines && (newShipping !== undefined || newDiscount !== undefined || sentTotal !== undefined)) {
      const { rows } = await client.query('SELECT line_price AS "linePrice" FROM order_items WHERE order_id = $1 AND tenant_id = $2', [orderId, tenantId]);
      lines = rows;
    }
    const hasItems = !!(lines && lines.length);
    if (hasItems) {
      if (items || newShipping !== undefined || newDiscount !== undefined) {
        // El impuesto usa la tasa de ESTE pedido (la foto de cuando se creó), no el ajuste actual del negocio
        const am = computeOrderAmounts(lines, newShipping ?? Number(found[0].shipping || 0), newDiscount ?? Number(found[0].discount || 0), found[0].tax_rate);
        values.push(am.total);
        sets.push(`total_price = $${values.length}`);
        values.push(am.tax);
        sets.push(`tax_amount = $${values.length}`);
      }
    } else if (sentTotal !== undefined) {
      // Con notas de crédito el total no se toca (como el envío y el descuento): el total efectivo nunca queda negativo
      if (hasCredit && centsOf(sentTotal) !== centsOf(found[0].total_price)) throw new BadRequest('Este pedido tiene devoluciones: no se puede cambiar el total');
      values.push(sentTotal);
      sets.push(`total_price = $${values.length}`);
    }
    if (!sets.length && !items && !(sentTotal !== undefined && hasItems)) throw new BadRequest('No hay cambios para guardar');

    sets.push('updated_at = NOW()');
    values.push(orderId, tenantId);
    let { rows } = await client.query(
      `UPDATE orders SET ${sets.join(', ')} WHERE id = $${values.length - 1} AND tenant_id = $${values.length} RETURNING *`,
      values
    );
    // Nunca por debajo de lo ya cobrado; si el total cambió, el estado de cobro se vuelve a derivar
    const paidCents = Math.round(Number(rows[0].amount_paid || 0) * 100);
    const totalCents = Math.round(Number(rows[0].total_price || 0) * 100) - Math.round(Number(rows[0].credited_total || 0) * 100);
    if (totalCents < paidCents) {
      const { rows: [bt] } = await client.query('SELECT base_currency FROM tenants WHERE id = $1', [tenantId]);
      throw new BadRequest(`El total no puede quedar por debajo de lo ya cobrado (${(paidCents / 100).toFixed(2)} ${(bt && bt.base_currency) || 'USD'})`);
    }
    if (String(rows[0].total_price) !== String(found[0].total_price)) rows = [await recalcOrderPayment(client, tenantId, orderId)];
    if (items) {
      // La foto del costo de las líneas que ya existían (mismo producto y variante) se conserva
      const { rows: oldLines } = await client.query('SELECT product_id, variant_key, unit_cost, qty FROM order_items WHERE order_id = $1 AND tenant_id = $2 ORDER BY ctid', [orderId, tenantId]);
      const oldCosts = new Map();
      for (const l of oldLines) {
        const k = l.product_id + '|' + (l.variant_key || '');
        if (l.product_id && !oldCosts.has(k)) oldCosts.set(k, l.unit_cost === null ? null : Number(l.unit_cost));
      }
      await client.query('DELETE FROM order_items WHERE order_id = $1 AND tenant_id = $2', [orderId, tenantId]);
      const stockLines = await insertOrderItems(client, tenantId, orderId, items, { snapshotCost: found[0].kind !== 'quote', oldCosts });
      // Existencias: se aplica SOLO la diferencia entre las líneas viejas y las nuevas (un presupuesto no mueve existencias)
      if (found[0].kind !== 'quote') {
        await ops.syncOrderStock(client, tenantId, orderId, stockLines, 'edit', actor,
          oldLines.map(l => ({ productId: l.product_id, variantKey: l.variant_key || '', qty: l.qty })));
      }
    }
    // Historial: la entrega va como status_changed; el resto de cambios como edited
    const clip = (v) => v === null || v === undefined ? null : String(v).slice(0, 200);
    const changes = {};
    for (const k of ['delivery_status', 'pay_method_label', 'delivery_method_label', 'address', 'notes', 'client_name',
      'product_summary', 'total_price', 'shipping', 'discount', 'client_id', 'delivery_date', 'delivery_zone', 'tax_amount']) {
      if (String(found[0][k] ?? '') !== String(rows[0][k] ?? '')) changes[k] = { from: clip(found[0][k]), to: clip(rows[0][k]) };
    }
    if (items) changes.items = { count: items.length };
    if (changes.delivery_status) {
      await addOrderEvent(client, tenantId, orderId, 'status_changed', changes.delivery_status, actor);
      delete changes.delivery_status;
    }
    if (Object.keys(changes).length) await addOrderEvent(client, tenantId, orderId, 'edited', { fields: Object.keys(changes), changes }, actor);
    const { rows: itemRows } = await client.query(
      'SELECT id, product_id, variant_key, emoji, name, detail, qty, unit_price, line_price FROM order_items WHERE order_id = $1 AND tenant_id = $2 ORDER BY ctid',
      [orderId, tenantId]
    );
    await client.query('COMMIT');
    rows[0].items = itemRows.map(it => ({
      id: it.id, productId: it.product_id, emoji: it.emoji, name: it.name,
      detail: it.detail, qty: it.qty, unitPrice: it.unit_price, linePrice: it.line_price, variantKey: it.variant_key || '',
    }));
    return ops.withName(client, tenantId, mapOrderRow(rows[0]), ops.BY_CREATED);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
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
    convoKey:       r.convo_key || null,
    // Saldo por cobrar (moneda base): Σ (total − cobrado) de sus pedidos con saldo
    balance:           money2(r.balance),
    ordersWithBalance: Number(r.orders_with_balance) || 0,
    // Compras vigentes (sin presupuestos ni anulados) y total comprado (efectivo): lo calcula el servidor, no la lista cargada
    ordersCount:       Number(r.orders_count) || 0,
    totalSpent:        money2(r.total_spent),
    // Saldo a favor (moneda base): lo que el negocio le debe al cliente (devoluciones dejadas como crédito)
    credit:            money2(r.credit),
    createdAt:      r.created_at,
    updatedAt:      r.updated_at,
  };
}

// Saldo por cobrar y saldo a favor de los clientes: UNA sola definición para la lista y para la ficha editada.
// Presupuestos y pedidos anulados no cuentan; el total es el EFECTIVO (menos notas de crédito). $2 = id de un
// cliente (o NULL para todos).
const CLIENT_BALANCE_SQL = `
    SELECT c.*, COALESCE(b.balance, 0) AS balance, COALESCE(b.n, 0) AS orders_with_balance, COALESCE(cr.credit, 0) AS credit,
      COALESCE(oc.n, 0) AS orders_count, COALESCE(oc.spent, 0) AS total_spent
    FROM clients c
    LEFT JOIN (
      SELECT client_id, COUNT(*) AS n, SUM(total_price - credited_total) AS spent
      FROM orders WHERE tenant_id = $1 AND client_id IS NOT NULL AND kind = 'order' AND delivery_status <> 'cancelled'
        AND ($2::uuid IS NULL OR client_id = $2::uuid)
      GROUP BY client_id
    ) oc ON oc.client_id = c.id
    LEFT JOIN (
      SELECT client_id, SUM(total_price - credited_total - amount_paid) AS balance, COUNT(*) AS n
      FROM orders WHERE tenant_id = $1 AND client_id IS NOT NULL AND kind = 'order' AND delivery_status <> 'cancelled'
        AND total_price - credited_total > amount_paid AND ($2::uuid IS NULL OR client_id = $2::uuid)
      GROUP BY client_id
    ) b ON b.client_id = c.id
    LEFT JOIN (
      SELECT client_id, SUM(amount) AS credit FROM client_credit_entries
      WHERE tenant_id = $1 AND ($2::uuid IS NULL OR client_id = $2::uuid) GROUP BY client_id
    ) cr ON cr.client_id = c.id
    WHERE c.tenant_id = $1 AND ($2::uuid IS NULL OR c.id = $2::uuid)`;

async function dbGetClients(tenantId) {
  if (!dbReady) return [];
  const { rows } = await pool.query(`${CLIENT_BALANCE_SQL} ORDER BY c.created_at DESC`, [tenantId, null]);
  return rows.map(mapClientRow);
}

async function dbUpsertClient(tenantId, data) {
  if (!dbReady) return null;
  if (data.id) {
    if (!UUID_RE.test(String(data.id))) return null; // id inválido → 404, no error de base
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
    if (!rows[0]) return null;
    // Los pedidos de la ficha muestran su nombre actual
    await pool.query('UPDATE orders SET client_name = $1 WHERE client_id = $2 AND tenant_id = $3 AND client_name IS DISTINCT FROM $1',
      [rows[0].name, rows[0].id, tenantId]);
    const { rows: [withBal] } = await pool.query(CLIENT_BALANCE_SQL, [tenantId, rows[0].id]);
    return mapClientRow(withBal || rows[0]);
  }
  const convoKey = typeof data.convoKey === 'string' && CONVO_KEY_RE.test(data.convoKey) ? data.convoKey : null;
  // Si ese chat ya tiene ficha, la nueva se guarda sin chat (nunca un error por el índice único)
  const insert = (key) => pool.query(`
    INSERT INTO clients (tenant_id, name, phone, ig, email, city, zone, address,
      extra_addresses, pay_method, channel, notes, is_vip, convo_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (tenant_id, convo_key) WHERE convo_key IS NOT NULL DO NOTHING
    RETURNING *
  `, [
    tenantId, data.name, data.phone || null, data.ig || null, data.email || null,
    data.city || null, data.zone || null, data.address || null,
    JSON.stringify(data.extraAddresses || []), data.payMethod || null,
    data.channel || null, data.notes || null, !!data.isVip, key,
  ]);
  let { rows } = await insert(convoKey);
  if (!rows[0]) ({ rows } = await insert(null));
  return mapClientRow(rows[0]);
}

async function dbDeleteClient(tenantId, clientId) {
  if (!dbReady) return false;
  if (!UUID_RE.test(String(clientId))) return false;
  // Un cliente con saldo a favor no se borra: ese dinero es suyo. Todo en una transacción: primero se bloquea la
  // ficha (mismo orden que lockedClientCreditC), así un pago con saldo a favor en curso no se cuela entre la
  // suma y el DELETE.
  return inTx(async (db) => {
    const { rows: lk } = await db.query('SELECT 1 FROM clients WHERE id = $1 AND tenant_id = $2 FOR UPDATE', [clientId, tenantId]);
    if (!lk[0]) return false;
    const { rows: [cr] } = await db.query(
      'SELECT COALESCE(SUM(amount), 0) AS b FROM client_credit_entries WHERE client_id = $1 AND tenant_id = $2', [clientId, tenantId]);
    if (centsOf(cr.b) !== 0) throw new BadRequest('Este cliente tiene saldo a favor: úsalo o devuélvelo antes de eliminarlo');
    const { rowCount } = await db.query('DELETE FROM clients WHERE id = $1 AND tenant_id = $2', [clientId, tenantId]);
    return rowCount > 0;
  });
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
    cost:          r.cost === null || r.cost === undefined ? null : Number(r.cost),
    trackStock:    !!r.track_stock,
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

// Costo (≥ 0 o null para borrarlo) y control de existencias: solo cambian si el cuerpo los trae (el PATCH reemplaza el resto)
function cleanProductCostFields(data) {
  let costSent = false, cost = null, track = null;
  if (data.cost !== undefined) {
    costSent = true;
    if (data.cost !== null && data.cost !== '') {
      const n = payNum(data.cost);
      if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) throw new BadRequest('Costo inválido (0 o más)');
      cost = Math.round(n * 100) / 100;
    }
  }
  const t = data.trackStock !== undefined ? data.trackStock : data.track_stock;
  if (t !== undefined) {
    if (typeof t !== 'boolean') throw new BadRequest('"trackStock" debe ser verdadero o falso');
    track = t;
  }
  return { costSent, cost, track };
}

async function dbUpsertProduct(tenantId, data) {
  if (!dbReady) return null;
  const cf = cleanProductCostFields(data);
  if (data.id) {
    const { rows } = await pool.query(`
      UPDATE catalog_products SET
        category_key = $1, category_name = $2, category_emoji = $3, name = $4,
        price = $5, emoji = $6, sizes = $7, colors = $8, description = $9, updated_at = NOW(),
        cost = CASE WHEN $12::boolean THEN $13::numeric ELSE cost END,
        track_stock = COALESCE($14::boolean, track_stock)
      WHERE id = $10 AND tenant_id = $11
      RETURNING *
    `, [
      data.categoryKey || null, data.categoryName || null, data.categoryEmoji || null,
      data.name, data.price || 0, data.emoji || null,
      JSON.stringify(data.sizes || []), JSON.stringify(data.colors || []),
      data.description || null, data.id, tenantId, cf.costSent, cf.cost, cf.track,
    ]);
    return rows[0] ? mapProductRow(rows[0]) : null;
  }
  const { rows } = await pool.query(`
    INSERT INTO catalog_products (tenant_id, category_key, category_name, category_emoji,
      name, price, emoji, sizes, colors, description, cost, track_stock)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::boolean, false))
    RETURNING *
  `, [
    tenantId, data.categoryKey || null, data.categoryName || null, data.categoryEmoji || null,
    data.name, data.price || 0, data.emoji || null,
    JSON.stringify(data.sizes || []), JSON.stringify(data.colors || []), data.description || null, cf.cost, cf.track,
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

function closeTenantSockets(tenantId) {
  const clients = tenantClients.get(String(tenantId));
  if (!clients) return;
  clients.forEach(ws => { try { ws.close(); } catch {} });
  tenantClients.delete(String(tenantId));
}

// Cierra los sockets abiertos de UN usuario (se desactiva, cambia de rol o de clave).
function closeUserSockets(tenantId, userId) {
  const clients = tenantClients.get(String(tenantId));
  if (!clients || !userId) return;
  for (const ws of [...clients]) {
    if (ws.userId === userId) { try { ws.close(); } catch {} clients.delete(ws); }
  }
}

// Un socket solo recibe datos después de autenticarse, y solo los de su negocio.
wss.on('connection', (ws) => {
  let tenantId = null;

  function rejectSocket(message) {
    try { ws.send(JSON.stringify({ type: 'auth_error', message })); } catch {}
    try { ws.close(); } catch {}
  }

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'ping') return;
    if (msg.type !== 'auth' || tenantId) return;
    let decoded;
    try {
      decoded = jwt.verify(msg.token, JWT_SECRET);
      if (!decoded.tenantId) throw new Error('sin tenant');
    } catch {
      return rejectSocket('Token inválido');
    }
    try {
      if (dbReady) {
        // Mismas comprobaciones que requireAuth: cuenta activa, usuario activo y sesión vigente (token_version)
        const sess = await resolveSession(decoded);
        if (sess.fail || sess.user.must_change_password) return rejectSocket(sess.fail ? 'Sesión no válida' : 'Cambia tu contraseña primero');
        ws.userId = sess.user.id;
      }
      if (ws.readyState !== 1) return;
      tenantId = String(decoded.tenantId);
      if (!tenantClients.has(tenantId)) tenantClients.set(tenantId, new Set());
      tenantClients.get(tenantId).add(ws);
      const convos = await dbGetConversations(tenantId);
      ws.send(JSON.stringify({ type: 'init', conversations: convos }));
      console.log(`🔌 Tenant ${tenantId} conectado via WebSocket`);
    } catch (err) {
      console.error('WebSocket auth:', err.message);
    }
  });

  // Si no se autentica en 10 s, se cierra
  const authTimer = setTimeout(() => {
    if (!tenantId) rejectSocket('Autenticación requerida');
  }, 10000);

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (tenantId && tenantClients.has(tenantId)) {
      tenantClients.get(tenantId).delete(ws);
    }
  });
});

// ══════════════════════════════════════════════════════════════
// JWT MIDDLEWARE
// ══════════════════════════════════════════════════════════════
// Firma el token de sesión de un usuario del equipo. El rol del token es solo informativo: el servidor lo lee SIEMPRE de la base.
function signUserToken(u) {
  return jwt.sign({ tenantId: u.tenant_id, userId: u.id, role: u.role, tv: u.token_version, email: u.email }, JWT_SECRET, { expiresIn: '30d' });
}
const SESSION_CLOSED = { status: 401, body: { error: 'session_closed', message: 'Tu sesión se cerró. Vuelve a iniciar sesión.' } };

// Valida una sesión (HTTP, WebSocket y /app): cuenta activa y vigente, usuario activo, token_version al día, plan y límite de equipo.
// Un token antiguo (sin userId) vale como el dueño del negocio hasta que caduque. Devuelve { fail: {status, body} } o { tenant, user }.
async function resolveSession(decoded) {
  if (!decoded || !decoded.tenantId || typeof decoded.tenantId !== 'string' || !UUID_RE.test(decoded.tenantId)) return { fail: { status: 401, body: { error: 'Token inválido o expirado' } } };
  const uid = decoded.userId === undefined || decoded.userId === null ? null : String(decoded.userId);
  if (uid !== null && !UUID_RE.test(uid)) return { fail: { status: 401, body: { error: 'Token inválido o expirado' } } };
  let row;
  try {
    ({ rows: [row] } = await pool.query(`
      SELECT t.active, t.expires_at, t.is_demo, t.plan, t.business_name, t.team_over_limit_since,
             u.id AS uid, u.name AS uname, u.email AS uemail, u.role AS urole, u.active AS uactive, u.token_version AS utv,
             u.must_change_password AS umust, u.temp_password_expires_at AS utemp,
             (SELECT count(*)::int FROM team_users a WHERE a.tenant_id = t.id AND a.active) AS active_users
      FROM tenants t
      LEFT JOIN team_users u ON u.tenant_id = t.id AND (CASE WHEN $2::uuid IS NULL THEN u.role = 'owner' ELSE u.id = $2::uuid END)
      WHERE t.id = $1`, [decoded.tenantId, uid]));
  } catch (err) { return { fail: { status: 500, body: { error: 'Error validando la cuenta' } } }; }
  // Revalidar en cada petición que la cuenta siga activa — para que una suspensión desde Central Admin bloquee el acceso
  // al instante, no solo en el próximo login.
  if (!row || !row.active) return { fail: { status: 403, body: { error: 'Tu cuenta ha sido suspendida. Contacta soporte.' }, suspended: true } };
  if (row.expires_at && new Date(row.expires_at) <= new Date()) {
    return { fail: { status: 403, body: { error: 'demo_expired', message: 'El período de demo ha finalizado. Contacta a Magic Design para activar tu cuenta.' } }, expired: true, tenantName: row.business_name };
  }
  if (!row.uid) return { fail: SESSION_CLOSED };
  if (!row.uactive) return { fail: { status: 401, body: { error: 'user_inactive', message: 'Tu usuario fue desactivado. Habla con el dueño del negocio.' } } };
  if (uid !== null && Number(decoded.tv) !== row.utv) return { fail: SESSION_CLOSED };
  if (row.umust && row.utemp && new Date(row.utemp) <= new Date()) {
    return { fail: { status: 401, body: { error: 'temp_password_expired', message: 'La contraseña temporal caducó. Pide al dueño que genere una nueva.' } } };
  }
  // Más usuarios activos que los del plan (bajada de plan): se marca el plazo de 3 días; pasado el plazo se desactivan los más recientes
  const over = row.active_users > team.planLimit(row.plan);
  try {
    if (over && !row.team_over_limit_since) {
      await pool.query('UPDATE tenants SET team_over_limit_since = now() WHERE id = $1 AND team_over_limit_since IS NULL', [decoded.tenantId]);
      row.team_over_limit_since = new Date();
    } else if (!over && row.team_over_limit_since) {
      await pool.query('UPDATE tenants SET team_over_limit_since = NULL WHERE id = $1', [decoded.tenantId]);
      row.team_over_limit_since = null;
    } else if (over && Date.now() >= new Date(row.team_over_limit_since).getTime() + team.OVER_LIMIT_GRACE_DAYS * 86400000) {
      await enforceTeamLimit(decoded.tenantId);
      const { rows: [again] } = await pool.query('SELECT active FROM team_users WHERE id = $1', [row.uid]);
      if (!again || !again.active) return { fail: { status: 401, body: { error: 'user_inactive', message: 'Tu usuario fue desactivado al bajar el plan. Habla con el dueño del negocio.' } } };
      row.team_over_limit_since = null;
    }
  } catch (err) { console.error('Límite de equipo:', err.message); }
  return {
    tenant: { active: row.active, isDemo: !!row.is_demo, plan: row.plan, businessName: row.business_name, expiresAt: row.expires_at, overLimitSince: row.team_over_limit_since },
    user: { id: row.uid, name: row.uname, email: row.uemail, role: row.urole, must_change_password: !!row.umust },
  };
}

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
  if (!decoded.tenantId) return res.status(401).json({ error: 'Token inválido o expirado' });
  if (dbReady) {
    const sess = await resolveSession(decoded);
    if (sess.fail) return res.status(sess.fail.status).json(sess.fail.body);
    decoded.isDemo = sess.tenant.isDemo;
    decoded.plan = sess.tenant.plan; // plan real de la base (no el del JWT)
    decoded.role = sess.user.role;   // el rol sale SIEMPRE de la base, nunca del token
    req.user = { id: sess.user.id, role: sess.user.role, name: sess.user.name, email: sess.user.email };
    // Contraseña temporal: solo se puede cambiar la contraseña hasta que lo haga
    const key = req.method + ' ' + (req.route?.path || req.path);
    if (sess.user.must_change_password && key !== 'PUT /api/tenant/password') {
      return res.status(403).json({ error: 'must_change_password', message: 'Cambia tu contraseña temporal para continuar.' });
    }
    // Rol: cada ruta tiene un rol mínimo; una ruta sin clasificar solo la usa el dueño
    const min = team.ROUTE_MIN_ROLE[key] || 'owner';
    if (!team.roleAtLeast(sess.user.role, min)) {
      return res.status(403).json({ error: 'role_forbidden', message: 'Tu rol no permite esta acción.' });
    }
  }
  req.tenant = decoded;
  if (decoded.isDemo) {
    let blocked;
    try { blocked = await demoGuard(req); }
    catch { return res.status(500).json({ error: 'Error validando la demo' }); }
    if (blocked) return res.status(blocked.status).json(blocked.body);
  }
  next();
}

// Desactiva a los usuarios más recientes hasta quedar en el límite del plan (nunca al dueño; nada se borra). Idempotente y
// segura entre réplicas: bloquea la fila del negocio.
async function enforceTeamLimit(tenantId) {
  const dropped = await inTx(async (c) => {
    const { rows: [t] } = await c.query('SELECT plan FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
    if (!t) return [];
    const limit = team.planLimit(t.plan);
    const { rows: act } = await c.query(
      `SELECT id FROM team_users WHERE tenant_id = $1 AND active ORDER BY (role = 'owner') DESC, created_at, id`, [tenantId]);
    const drop = act.slice(limit).map(r => r.id);
    if (drop.length) {
      await c.query(`UPDATE team_users SET active = false, deactivated_at = now(), token_version = token_version + 1
        WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND role <> 'owner'`, [tenantId, drop]);
    }
    await c.query('UPDATE tenants SET team_over_limit_since = NULL WHERE id = $1', [tenantId]);
    return drop;
  });
  for (const id of dropped) closeUserSockets(tenantId, id);
  return dropped;
}

// ── Aislamiento de cuentas demo ────────────────────────────────
// Una demo solo puede usar las rutas de esta lista. Cualquier ruta nueva queda
// bloqueada para demos hasta que se añada aquí de forma explícita.
const DEMO_ALLOWED_ROUTES = new Set([
  'GET /api/tenant/profile', 'PUT /api/tenant/profile',
  'GET /api/tenant/auto-reply', 'PUT /api/tenant/auto-reply',
  'GET /api/conversations', 'GET /api/conversations/:waId',
  'GET /api/orders', 'POST /api/orders', 'PATCH /api/orders/:id',
  'GET /api/orders/:id/payments', 'POST /api/orders/:id/payments', 'POST /api/payments/:id/void',
  'GET /api/payments', 'GET /api/orders/:id/events',
  // Fase 3: ciclo del pedido (nada de esto llama a servicios externos)
  'POST /api/orders/:id/convert', 'POST /api/orders/:id/cancel', 'POST /api/orders/:id/returns',
  'GET /api/orders/:id/returns', 'GET /api/clients/:id/credit',
  'GET /api/tenant/settings', 'PUT /api/tenant/settings',
  'GET /api/reports',
  // Fase 4A: gastos, cierre de caja, existencias, utilidad (nada de esto llama a servicios externos)
  'GET /api/expenses', 'POST /api/expenses', 'POST /api/expenses/:id/void',
  'GET /api/cash', 'GET /api/cash/:day', 'POST /api/cash/:day/close', 'POST /api/cash/:day/reopen', 'GET /api/cash-closed',
  'GET /api/stock', 'POST /api/stock/adjust', 'GET /api/stock/movements',
  'GET /api/reports/profit', 'GET /api/reports/receivables',
  'GET /api/clients', 'POST /api/clients', 'PATCH /api/clients/:id', 'DELETE /api/clients/:id',
  'GET /api/catalog', 'POST /api/catalog', 'PATCH /api/catalog/:id', 'DELETE /api/catalog/:id',
  'POST /api/send', 'POST /api/send-media', 'POST /api/send-ticket', 'POST /api/send-instagram',
  'GET /api/billing/status', 'POST /api/billing/create-checkout', 'POST /api/billing/cancel', 'POST /api/billing/portal',
  // Fase 4B: equipo (una demo puede ver y crear usuarios dentro del tope; nunca se envía correo). Cambiar la contraseña sigue bloqueado.
  'GET /api/team', 'POST /api/team', 'PATCH /api/team/:id', 'POST /api/team/:id/reset-password', 'POST /api/team/resolve-limit',
]);
const DEMO_MAX_BODY = 1024 * 1024;
const DEMO_MAX_EVENTS = 5000;   // filas de order_events por demo (cada edición/pago/anulación añade una)
const DEMO_MAX_PAYMENTS = 600;
const EV_LIMIT = ['order_events', DEMO_MAX_EVENTS];
const MV_LIMIT = ['stock_movements', 3000]; // cada venta, edición, anulación, devolución o ajuste añade movimientos
const CN_LIMIT = ['credit_notes', 200], REFUND_LIMIT = ['refunds', 300], CREDIT_LIMIT = ['client_credit_entries', 600];
// ruta → lista de [tabla, máximo]; todas cuentan filas del propio negocio
const DEMO_ROW_LIMITS = {
  'POST /api/orders': [['orders', 300], EV_LIMIT, MV_LIMIT],
  'PATCH /api/orders/:id': [EV_LIMIT, MV_LIMIT],
  'POST /api/expenses': [['expenses', 300]],
  'POST /api/cash/:day/close': [['cash_closings', 60]],
  'POST /api/stock/adjust': [MV_LIMIT, ['stock_levels', 1500]],
  'POST /api/orders/:id/payments': [['payments', DEMO_MAX_PAYMENTS], EV_LIMIT, CREDIT_LIMIT],
  'POST /api/payments/:id/void': [EV_LIMIT, CREDIT_LIMIT],
  'POST /api/orders/:id/convert': [EV_LIMIT, MV_LIMIT],
  'POST /api/orders/:id/cancel': [EV_LIMIT, REFUND_LIMIT, CREDIT_LIMIT, MV_LIMIT],
  'POST /api/orders/:id/returns': [CN_LIMIT, ['credit_note_items', 2000], REFUND_LIMIT, CREDIT_LIMIT, EV_LIMIT, MV_LIMIT],
  'POST /api/clients': [['clients', 300]], 'POST /api/catalog': [['catalog_products', 100]],
  'POST /api/team': [['team_users', 10]],
  'POST /api/send': [['messages', 600]], 'POST /api/send-media': [['messages', 600]],
  'POST /api/send-ticket': [['messages', 600]], 'POST /api/send-instagram': [['messages', 600]],
};
const DEMO_BLOCKED = { status: 403, body: { error: 'demo_blocked', message: 'Esta función no está disponible en la demo.' } };

async function demoGuard(req) {
  const key = req.method + ' ' + (req.route?.path || req.path);
  if (!DEMO_ALLOWED_ROUTES.has(key)) return DEMO_BLOCKED;
  const tooBig = { status: 413, body: { error: 'demo_limit', message: 'En la demo los archivos y datos están limitados a 1 MB.' } };
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const len = req.headers['content-length'];
    if (len === undefined) return { status: 411, body: { error: 'demo_limit', message: 'Petición no válida en la demo.' } };
    if (parseInt(len, 10) > DEMO_MAX_BODY) return tooBig;
    if (req.body && JSON.stringify(req.body).length > DEMO_MAX_BODY) return tooBig;
  }
  if ((key === 'POST /api/orders' || key === 'PATCH /api/orders/:id') && Array.isArray(req.body?.items) && req.body.items.length > 30) {
    return { status: 400, body: { error: 'demo_limit', message: 'En la demo un pedido admite hasta 30 artículos.' } };
  }
  const limits = [...(DEMO_ROW_LIMITS[key] || [])];
  // Un pedido nuevo con pago inicial también crea una fila en payments
  if (key === 'POST /api/orders' && req.body && req.body.initialPayment) limits.push(['payments', DEMO_MAX_PAYMENTS], CREDIT_LIMIT);
  for (const [table, max] of limits) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE tenant_id = $1`, [req.tenant.tenantId]);
    if (rows[0].n >= max) {
      return { status: 429, body: { error: 'demo_limit', message: 'Has llegado al límite de datos de la demo.' } };
    }
  }
  return null;
}

// Facturación simulada: en una demo nunca se llama a Stripe
function demoBilling(kind) {
  return async (req, res, next) => {
    if (req.tenant?.isDemo === false) return next();
    if (req.tenant?.isDemo !== true) return res.status(503).json({ error: 'Servicio no disponible, intenta en un momento' });
    const tenantId = req.tenant.tenantId;
    try {
      if (kind === 'status') {
        const { rows } = await pool.query('SELECT plan, expires_at FROM tenants WHERE id = $1 AND is_demo = true', [tenantId]);
        return res.json({ plan: rows[0]?.plan || 'business', billingStatus: 'demo', demo: true,
          hasSubscription: false, nextBillingDate: null, planExpiresAt: rows[0]?.expires_at || null });
      }
      if (kind === 'checkout') {
        const plan = req.body?.plan;
        if (!['basic', 'pro', 'business'].includes(plan)) return res.status(400).json({ error: 'Plan inválido' });
        // Bajar de plan con más usuarios activos que el límite nuevo: el dueño elige a quién mantener (keepUserIds); el resto
        // se desactiva en la misma operación. Sin la lista → 400 con los usuarios para elegir.
        const dropped = await inTx(async (c) => {
          const { rows: [t] } = await c.query('SELECT 1 FROM tenants WHERE id = $1 AND is_demo = true FOR UPDATE', [tenantId]);
          if (!t) return [];
          const limit = team.planLimit(plan);
          const { rows: act } = await c.query(`SELECT id, name, role FROM team_users WHERE tenant_id = $1 AND active AND role <> 'owner' ORDER BY created_at, id`, [tenantId]);
          let drop = [];
          if (act.length + 1 > limit) {
            if (req.body.keepUserIds === undefined) {
              throw new TeamError('keep_users_required', `El plan ${plan} admite ${limit} usuario(s) contando al dueño: elige a quién mantener.`, { limit, users: act });
            }
            drop = await applyKeepUsers(c, tenantId, limit, req.body.keepUserIds);
          }
          await c.query('UPDATE tenants SET plan = $1, team_over_limit_since = NULL WHERE id = $2 AND is_demo = true', [plan, tenantId]);
          return drop;
        });
        for (const id of dropped) closeUserSockets(tenantId, id);
        return res.json({ demo: true, plan, message: 'Plan cambiado. En la demo no se realiza ningún cobro.', deactivatedUsers: dropped.length });
      }
      return res.json({ demo: true, message: 'En la demo no hay suscripción ni cobros: cambia de plan cuando quieras sin coste.' });
    } catch (err) {
      if (err instanceof BadRequest) return res.status(400).json(badRequestBody(err));
      return res.status(500).json({ error: 'Error en la demo' });
    }
  };
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

// ── Envío de texto por WhatsApp / Instagram (devuelven el id del mensaje) ──
async function sendWaText(creds, waId, text) {
  const response = await axios.post(
    `${GRAPH_BASE}/${creds.whatsapp_phone_number_id}/messages`,
    { messaging_product:'whatsapp', to:waId, type:'text', text:{ body:text } },
    { headers: { Authorization:`Bearer ${creds.whatsapp_token}`, 'Content-Type':'application/json' } }
  );
  return response.data.messages?.[0]?.id || 'local_' + Date.now();
}

async function sendIgText(creds, igId, text) {
  const response = await axios.post(
    `https://graph.instagram.com/${GRAPH_API_VERSION}/me/messages`,
    { recipient:{ id: igId }, message:{ text } },
    { headers: { Authorization:`Bearer ${creds.instagram_access_token}`, 'Content-Type':'application/json' } }
  );
  return response.data.message_id || 'ig_out_' + Date.now();
}

// ══════════════════════════════════════════════════════════════
// RESPUESTA AUTOMÁTICA FUERA DE HORARIO (la envía el servidor)
// ══════════════════════════════════════════════════════════════
const SCHEDULE_DAYS = ['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'];
const DEFAULT_SCHEDULE = [
  { day:'Lunes',     open:'09:00', close:'19:00', active:true },
  { day:'Martes',    open:'09:00', close:'19:00', active:true },
  { day:'Miércoles', open:'09:00', close:'19:00', active:true },
  { day:'Jueves',    open:'09:00', close:'19:00', active:true },
  { day:'Viernes',   open:'09:00', close:'20:00', active:true },
  { day:'Sábado',    open:'10:00', close:'17:00', active:true },
  { day:'Domingo',   open:'10:00', close:'14:00', active:false },
];
const DEFAULT_OFF_HOURS_MESSAGE = '¡Hola! 🌙 Gracias por escribirnos. Estamos fuera de horario pero te responderemos a primera hora mañana. Nuestro horario es Lun-Sáb 9am-7pm.';
const DEFAULT_TIMEZONE = 'America/Caracas';

function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function isValidSchedule(schedule) {
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  return Array.isArray(schedule) && schedule.length === 7 && schedule.every((d, i) =>
    d && d.day === SCHEDULE_DAYS[i] && HHMM.test(d.open) && HHMM.test(d.close) && typeof d.active === 'boolean');
}

// ¿Está abierto el negocio ahora mismo, en su zona horaria?
function isWithinBusinessHours(schedule, timezone, now = new Date()) {
  const tz = isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).map(p => [p.type, p.value]));
  const dayIdx = { Mon:0, Tue:1, Wed:2, Thu:3, Fri:4, Sat:5, Sun:6 }[parts.weekday];
  const days = isValidSchedule(schedule) ? schedule : DEFAULT_SCHEDULE;
  const today = days[dayIdx];
  if (!today || !today.active) return false;
  const toMins = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const nowMins = (parseInt(parts.hour, 10) % 24) * 60 + parseInt(parts.minute, 10);
  return nowMins >= toMins(today.open) && nowMins < toMins(today.close);
}

// Se llama después de guardar un mensaje entrante. Envía como máximo una respuesta
// por conversación y por día (día del negocio), aunque lleguen varios mensajes a la vez.
async function maybeSendAutoReply(tenant, convoKey, platform, igSenderId = null) {
  if (!dbReady || !tenant || !tenant.auto_reply_enabled || tenant.is_demo) return;
  const tz = ops.tzOf(tenant) || DEFAULT_TIMEZONE;
  if (isWithinBusinessHours(tenant.business_hours, tz)) return;

  const { rows } = await pool.query(`
    UPDATE conversations SET last_auto_reply_at = NOW()
    WHERE wa_id = $1 AND tenant_id = $2
      AND (last_auto_reply_at IS NULL
           OR (last_auto_reply_at AT TIME ZONE $3)::date < (NOW() AT TIME ZONE $3)::date)
    RETURNING wa_id
  `, [convoKey, tenant.id, tz]);
  if (!rows[0]) return; // ya se respondió hoy

  const text = (tenant.off_hours_message || DEFAULT_OFF_HOURS_MESSAGE).slice(0, 1000);
  try {
    const id = platform === 'ig'
      ? await sendIgText(tenant, igSenderId, text)
      : await sendWaText(tenant, convoKey, text);
    const sentMessage = { id, role: 'out', type: 'text', text, time: new Date().toISOString() };
    await dbSaveMessage(sentMessage, convoKey, tenant.id);
    broadcastToTenant(tenant.id, { type: 'message_sent', waId: convoKey, platform, auto: true, message: sentMessage });
    console.log(`🌙 Respuesta automática enviada a ${convoKey} (tenant ${tenant.id})`);
  } catch (err) {
    // Si falló el envío, se libera la marca para reintentar con el próximo mensaje
    await pool.query('UPDATE conversations SET last_auto_reply_at = NULL WHERE wa_id = $1 AND tenant_id = $2',
      [convoKey, tenant.id]).catch(() => {});
    console.error('Respuesta automática no enviada:', err.response?.data || err.message);
  }
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
    // El HTML del ticket viene del navegador: sin JavaScript y sin peticiones salvo las
    // fuentes de Google, para que un ticket manipulado no pueda hacer llamadas desde el servidor.
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      const url = r.url();
      if (url.startsWith('data:') || url === 'about:blank' ||
          /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(url)) return r.continue();
      r.abort();
    });
    await page.setViewport({ width, height: 100, deviceScaleFactor: 2 });
    await page.setContent(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,'Segoe UI',Arial,sans-serif;}body{background:#fff;padding:20px;width:${width-40}px;}</style></head><body>${htmlContent}</body></html>`, { waitUntil: 'networkidle0' });
    const body = await page.$('body');
    const box  = await body.boundingBox();
    return await page.screenshot({ type: 'png', clip: { x:0, y:0, width, height: Math.ceil(box.height) } });
  } finally {
    await page.close();
  }
}

// Estilo del ticket (resguardo / presupuesto) con los colores de CENTRAL. Vive en el servidor:
// el navegador solo manda el contenido, nunca CSS propio.
const TICKET_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=Syne:wght@400;600;700;800&display=swap');
  :root { --surface2:#16161f; --surface3:#1c1c28; --border:rgba(255,255,255,0.07); --border2:rgba(255,255,255,0.12);
    --accent:#6c63ff; --accent2:#8b85ff; --green:#22d3a0; --text:#f0f0f8; --text2:#9090a8; --text3:#5a5a72; --yellow:#f5c842; }
  * { box-sizing:border-box; margin:0; padding:0; font-family:'DM Sans',-apple-system,'Segoe UI',Arial,sans-serif; }
  body { background:#0f0f17 !important; }
  .ticket-bubble { background:#16161f; border:1px solid rgba(255,255,255,0.12); border-radius:14px; overflow:hidden; width:300px; }
  .ticket-header { background:linear-gradient(135deg,rgba(108,99,255,0.25),rgba(168,85,247,0.15)); border-bottom:1px solid rgba(255,255,255,0.12);
    padding:10px 14px; display:flex; align-items:center; gap:8px; }
  .ticket-header-icon { width:28px; height:28px; border-radius:8px; background:#6c63ff; display:flex; align-items:center; justify-content:center; font-size:13px; flex-shrink:0; }
  .ticket-header-title { font-family:'Syne',sans-serif; font-size:12px; font-weight:800; color:#f0f0f8; line-height:1.2; }
  .ticket-header-sub { font-size:10px; color:#9090a8; margin-top:1px; }
  .ticket-body { padding:10px 14px; display:flex; flex-direction:column; gap:7px; }
  .ticket-row { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; font-size:11.5px; }
  .ticket-row-label { color:#5a5a72; font-weight:500; }
  .ticket-row-value { color:#f0f0f8; font-weight:600; text-align:right; max-width:170px; }
  .ticket-divider { height:1px; background:rgba(255,255,255,0.07); margin:2px 0; }
  .ticket-total { display:flex; justify-content:space-between; align-items:center; font-size:13px; font-weight:700; color:#5a5a72;
    padding-top:4px; border-top:1px solid rgba(255,255,255,0.12); margin-top:2px; }
  .ticket-total-val { color:#5a5a72; font-family:'Syne',sans-serif; }
  .ticket-footer { background:#1c1c28; border-top:1px solid rgba(255,255,255,0.07); padding:8px 14px; text-align:center; font-size:10px; color:#5a5a72; line-height:1.4; }
  .ticket-id { font-size:9.5px; font-weight:700; color:#8b85ff; letter-spacing:0.5px; margin-bottom:2px; }
`;

// Convierte el contenido de un ticket (lo que va dentro de .ticket-bubble) en un PNG con su estilo
async function renderTicketImage(ticketHtml) {
  return renderHtmlToImage(`<style>${TICKET_CSS}</style><div class="ticket-bubble">${ticketHtml}</div>`, 340);
}

// ══════════════════════════════════════════════════════════════
// HELPERS — Media (Meta Graph API)
// ══════════════════════════════════════════════════════════════

async function downloadMediaFromMeta(mediaId, token, tenantId) {
  const t = token || DEFAULT_WA_TOKEN;
  const urlRes = await axios.get(`${GRAPH_BASE}/${mediaId}`, { headers: { Authorization: `Bearer ${t}` } });
  const { url, mime_type, file_size } = urlRes.data;
  const fileRes = await axios.get(url, { headers: { Authorization: `Bearer ${t}` }, responseType: 'arraybuffer' });
  const buffer = Buffer.from(fileRes.data);
  mediaCache[mediaId] = { buffer, mimeType: mime_type, size: file_size, tenantId: String(tenantId) };
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
  if (VERIFY_TOKEN && mode === 'subscribe' && token === VERIFY_TOKEN) {
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
    if (senderId === igAccountId) return; // eco propio

    const tenant = await dbGetTenantByIgAccountId(igAccountId);
    if (!tenant) {
      console.warn(`⚠️  Instagram: cuenta ${igAccountId} sin negocio asociado — mensaje descartado`);
      return;
    }
    const tenantId = tenant.id;
    const igToken  = tenant.instagram_access_token;
    if (senderId === tenant.instagram_account_id) return;

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

    broadcastToTenant(tenantId, { type:'new_message', waId:convoKey, name:senderName, platform:'ig', message:newMessage });
    maybeSendAutoReply(tenant, convoKey, 'ig', senderId).catch(err => console.error('Respuesta automática IG:', err.message));
  } catch (err) {
    console.error('Error procesando webhook Instagram:', err.message);
  }
}

// ══════════════════════════════════════════════════════════════
// WEBHOOK — WhatsApp Business
// ══════════════════════════════════════════════════════════════
// Comprueba que la llamada la firmó Meta (HMAC-SHA256 del body con la clave secreta de la app)
function hasValidMetaSignature(req) {
  const header = String(req.headers['x-hub-signature-256'] || '');
  if (!header || !req.rawBody) return false;
  const given = Buffer.from(header);
  return [META_APP_SECRET, INSTAGRAM_APP_SECRET].filter(Boolean).some(secret => {
    const expected = Buffer.from('sha256=' + crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex'));
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

app.post('/webhook', async (req, res) => {
  if (!META_APP_SECRET && !INSTAGRAM_APP_SECRET) {
    if (IS_PROD) {
      console.error('❌ Webhook rechazado: falta META_APP_SECRET en las variables de entorno');
      return res.sendStatus(503);
    }
    console.warn('⚠️  META_APP_SECRET no configurada — webhook sin validar firma (solo en local)');
  } else if (!hasValidMetaSignature(req)) {
    console.warn('❌ Webhook con firma inválida o ausente — rechazado');
    return res.sendStatus(401);
  }
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
    const tenant = phoneNumberId ? await dbGetTenantByPhoneId(phoneNumberId) : null;
    if (!tenant) {
      console.warn(`⚠️  WhatsApp: phone_number_id ${phoneNumberId || '(vacío)'} sin negocio asociado — descartado`);
      return;
    }
    const tenantId = tenant.id;
    const waToken  = tenant.whatsapp_token;

    const messages = value?.messages;
    if (!messages || messages.length === 0) {
      const statuses = value?.statuses;
      if (statuses?.length > 0) {
        statuses.forEach(st => {
          broadcastToTenant(tenantId, { type:'message_status', messageId:st.id, status:st.status, waId:st.recipient_id });
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
        try { await downloadMediaFromMeta(info.id, waToken, tenantId); } catch {}
      } else {
        newMessage.type = 'text';
        newMessage.text = `[Tipo no soportado: ${msg.type}]`;
      }

      await dbSaveMessage(newMessage, waId, tenantId);
      console.log(`📩 Mensaje de ${contactName} (${waId}): ${newMessage.type}`);

      broadcastToTenant(tenantId, { type:'new_message', waId, name:contactName, message:newMessage });
      maybeSendAutoReply(tenant, waId, 'wa').catch(err => console.error('Respuesta automática WA:', err.message));
    }
  } catch (err) {
    console.error('Error procesando webhook WhatsApp:', err);
  }
});

// ══════════════════════════════════════════════════════════════
// API — Tenants: registro, login, perfil
// ══════════════════════════════════════════════════════════════

app.post('/api/tenant/register', async (req, res) => {
  const { businessName, fullName, password, country, whatsappNumber, plan } = req.body;
  // Toda cuenta nueva nace en 'basic'; un plan de pago pedido solo se devuelve (requestedPlan) para que el SPA lleve a pagar
  const requestedPlan = ['pro', 'business'].includes(plan) ? plan : null;
  const email = normEmail(req.body.email);
  if (!businessName || !email || !password) {
    return res.status(400).json({ error: 'Faltan campos obligatorios', field: 'businessName' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Correo electrónico inválido', field: 'email' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres', field: 'password' });
  }
  if (pwTooLong(password)) return res.status(400).json({ error: PW_TOO_LONG_MSG, field: 'password' });
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });

  try {
    const hash = await bcrypt.hash(password, 10);
    // País de la lista cerrada (nombre canónico); la zona horaria sale SOLO del país (la de por defecto; «Otro» → se elige en Ajustes)
    const countryCanon = ops.canonCountry(country);
    const { rows } = await pool.query(`
      INSERT INTO tenants (business_name, full_name, email, password_hash, plan, country, whatsapp_number, timezone)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, business_name, full_name, email, plan, country, timezone, created_at
    `, [businessName, fullName || null, email, hash, 'basic', countryCanon || (country ? String(country).trim().slice(0, 80) : null),
         whatsappNumber || null, ops.defaultTimezoneFor(countryCanon)]);
    const tenant = rows[0];
    // El trigger de la base ya creó al dueño en team_users (espejo del negocio)
    const { rows: [owner] } = await pool.query("SELECT * FROM team_users WHERE tenant_id = $1 AND role = 'owner'", [tenant.id]);
    const token  = signUserToken(owner);
    if (process.env.RESEND_API_KEY) {
      sendWelcomeEmail(tenant.email, tenant.business_name).catch(err =>
        console.error('[EMAIL] Bienvenida no enviada:', err.message)
      );
    }
    res.json({
      success: true,
      token,
      requestedPlan,
      tenant: { id: tenant.id, businessName: tenant.business_name, fullName: tenant.full_name, email: tenant.email, plan: tenant.plan, country: tenant.country },
      user: { id: owner.id, name: owner.name, email: owner.email, role: owner.role, mustChangePassword: false },
    });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Este correo ya está registrado', field: 'email' });
    res.status(500).json({ error: 'Error al registrar', details: err.message });
  }
});

app.post('/api/tenant/login', async (req, res) => {
  const { password } = req.body;
  const email = normEmail(req.body.email);
  if (!email || !password) return res.status(400).json({ error: 'Completa todos los campos' });
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });

  try {
    // Cada persona del negocio (dueño incluido) es una fila de team_users; el correo es único en toda la base
    const { rows } = await pool.query(`
      SELECT u.*, t.business_name, t.full_name AS tenant_full_name, t.plan, t.country, t.active AS tenant_active, t.expires_at
      FROM team_users u JOIN tenants t ON t.id = u.tenant_id WHERE lower(u.email) = $1 LIMIT 1`, [email]);
    const u = rows[0];
    if (!u) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    if (!u.tenant_active) return res.status(403).json({ error: 'Tu cuenta ha sido suspendida. Contacta soporte.' });
    // Freno por usuario además del de IP: el intento se cuenta ANTES de comparar (peticiones en paralelo no lo esquivan)
    if (loginBlocked(u.id)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.' });
    loginFailed(u.id);
    const valid = typeof password === 'string' && await bcrypt.compare(password, u.password_hash);
    if (!valid)  return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    userLoginFailures.delete(u.id);
    if (!u.active) return res.status(403).json({ error: 'user_inactive', message: 'Tu usuario fue desactivado. Habla con el dueño del negocio.' });
    if (u.expires_at && new Date(u.expires_at) <= new Date()) {
      return res.status(403).json({ error: 'demo_expired', message: 'Tu período de demo ha finalizado. Escríbenos a info@magicdesignllc.com para activar tu cuenta.' });
    }
    if (u.must_change_password && u.temp_password_expires_at && new Date(u.temp_password_expires_at) <= new Date()) {
      return res.status(401).json({ error: 'temp_password_expired', message: 'La contraseña temporal caducó. Pide al dueño que genere una nueva.' });
    }
    await pool.query('UPDATE team_users SET last_login_at = now() WHERE id = $1', [u.id]);
    const token = signUserToken(u);
    const isOwner = u.role === 'owner';
    res.json({
      success: true,
      token,
      mustChangePassword: !!u.must_change_password,
      tenant: { id: u.tenant_id, businessName: u.business_name, fullName: isOwner ? u.tenant_full_name : u.name, email: u.email, plan: u.plan, country: u.country },
      user: { id: u.id, name: u.name, email: u.email, role: u.role, mustChangePassword: !!u.must_change_password },
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
  const email = normEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Correo requerido' });
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const { rows } = await pool.query('SELECT id, is_demo FROM tenants WHERE lower(email) = $1 AND active = true', [email]);
    // Siempre responder OK para no revelar si el correo existe
    if (rows[0] && !rows[0].is_demo) {
      const token   = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hora
      await pool.query('UPDATE tenants SET reset_token=$1, reset_token_expires=$2 WHERE id=$3', [token, expires, rows[0].id]);
      const resetUrl = `${APP_URL.replace(/\/$/, '')}/reset-password.html?token=${token}`;
      if (process.env.RESEND_API_KEY) {
        // Si Resend falla se registra en el log, pero la respuesta es la misma: no se
        // revela si el correo existe ni se deja el formulario cargando.
        try { await sendResetEmail(email, resetUrl); }
        catch (err) { console.error('[EMAIL] Recuperación no enviada:', err.message); }
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
  if (pwTooLong(password)) return res.status(400).json({ error: PW_TOO_LONG_MSG });
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const { rows } = await pool.query(
      'SELECT id FROM tenants WHERE reset_token=$1 AND reset_token_expires > NOW() AND active=true AND is_demo IS NOT TRUE',
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
      'SELECT id, business_name, full_name, email, plan, country, timezone, whatsapp_number, whatsapp_phone_number_id, instagram_account_id, created_at FROM tenants WHERE id = $1',
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
      ...locationOf(t), // country, timezone (efectiva; null si falta) y timezoneOptions (zonas de su país)
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

// Cambio de contraseña (no está en DEMO_ALLOWED_ROUTES: las demos no pueden usarla)
app.put('/api/tenant/password', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || !currentPassword || typeof newPassword !== 'string') {
    return res.status(400).json({ error: 'Escribe tu contraseña actual y la nueva' });
  }
  if (newPassword.length < 8) return res.status(400).json({ error: 'La contraseña nueva debe tener al menos 8 caracteres' });
  if (pwTooLong(newPassword)) return res.status(400).json({ error: PW_TOO_LONG_MSG });
  try {
    // Cada usuario cambia SU contraseña. La del dueño vive en tenants (fuente; un trigger la copia a team_users y sube su
    // token_version); la de los demás en team_users.
    const isOwner = req.user.role === 'owner';
    const { rows } = isOwner
      ? await pool.query('SELECT password_hash FROM tenants WHERE id = $1', [req.tenant.tenantId])
      : await pool.query('SELECT password_hash FROM team_users WHERE id = $1 AND tenant_id = $2', [req.user.id, req.tenant.tenantId]);
    if (!rows[0]) return res.status(404).json({ error: 'Tenant no encontrado' });
    const bad = await checkCurrentPassword(isOwner ? req.tenant.tenantId : 'u:' + req.user.id, currentPassword, rows[0].password_hash);
    if (bad) return res.status(bad[0]).json({ error: bad[1] });
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'La contraseña nueva debe ser distinta de la actual' });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    if (isOwner) await pool.query('UPDATE tenants SET password_hash = $1 WHERE id = $2', [hash, req.tenant.tenantId]);
    else {
      await pool.query(`UPDATE team_users SET password_hash = $1, must_change_password = false, temp_password_expires_at = NULL,
        token_version = token_version + 1 WHERE id = $2 AND tenant_id = $3`, [hash, req.user.id, req.tenant.tenantId]);
    }
    // Las sesiones anteriores (otros dispositivos) quedan cerradas; esta recibe un token nuevo
    const { rows: [u] } = await pool.query('SELECT * FROM team_users WHERE id = $1', [req.user.id]);
    closeUserSockets(req.tenant.tenantId, req.user.id);
    res.json({ success: true, token: signUserToken(u) });
  } catch (err) {
    console.error('password change error:', err);
    res.status(500).json({ error: 'Error al cambiar la contraseña' });
  }
});

// Fija país y zona horaria de un negocio (DENTRO de una transacción). Bloquea la fila del tenant FOR UPDATE: así un cierre de caja
// (también FOR UPDATE) y un cambio de zona se serializan. Reglas:
//  · país: de la lista cerrada (sin cambios respecto al guardado = no se valida de nuevo, para no bloquear fichas antiguas)
//  · zona: la elegida debe pertenecer al país; sin elegir, se conserva la guardada si es de ese país y, si no, la de por defecto
//    (países de una sola zona: se asigna sola). «Otro» sin zona válida → null.
//  · si la zona efectiva cambia y hay cierres de caja vigentes (reopened_at NULL), 400: los días cerrados se descuadrarían.
async function applyTenantLocation(db, tenantId, { country, timezone }) {
  const { rows: [cur] } = await db.query('SELECT country, timezone FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
  if (!cur) return null;
  let newCountry = cur.country;
  // '' o null con un país guardado vacío/null = «sin cambio» (un negocio sin país puede editar otros campos)
  if (country !== undefined && country !== cur.country && !(!country && !cur.country)) {
    const c = ops.canonCountry(country);
    if (!c) throw new BadRequest('País no válido: elige uno de la lista');
    newCountry = c;
  }
  let tz;
  if (timezone !== undefined && timezone !== null && timezone !== '') {
    if (typeof timezone !== 'string' || !ops.tzValidForCountry(newCountry, timezone)) throw new BadRequest('Esa zona horaria no pertenece al país del negocio');
    tz = timezone;
  } else tz = ops.tzOf({ country: newCountry, timezone: cur.timezone });
  if (tz !== ops.tzOf(cur)) {
    const { rows: [open] } = await db.query('SELECT 1 FROM cash_closings WHERE tenant_id = $1 AND reopened_at IS NULL LIMIT 1', [tenantId]);
    if (open) throw new BadRequest('No se puede cambiar la zona horaria mientras haya cierres de caja vigentes: reabre esos días en Gastos → Cierre de caja primero (plan Básico: Ajustes → Perfil)');
  }
  await db.query('UPDATE tenants SET country = $2, timezone = $3 WHERE id = $1', [tenantId, newCountry, tz]);
  return { country: ops.canonCountry(newCountry) || newCountry, timezone: tz };
}

app.put('/api/tenant/profile', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  // El correo de acceso (y la clave) del negocio son del dueño: un encargado puede editar el resto del perfil
  if (req.user.role !== 'owner' && req.body && req.body.email !== undefined) {
    const { rows: [cur] } = await pool.query('SELECT email FROM tenants WHERE id = $1', [req.tenant.tenantId]);
    if (!cur || normEmail(req.body.email) !== normEmail(cur.email)) {
      return res.status(403).json({ error: 'role_forbidden', message: 'Solo el dueño puede cambiar el correo de acceso.' });
    }
  }
  const allowed = req.tenant.isDemo || req.user.role !== 'owner'
    ? ['business_name', 'full_name', 'whatsapp_number']
    : ['business_name', 'full_name', 'email', 'whatsapp_number'];
  const wantsLocation = req.body && (req.body.country !== undefined || req.body.timezone !== undefined);
  const sets = [];
  const values = [];
  let i = 1;
  for (const [key, raw] of Object.entries(req.body || {})) {
    if (!allowed.includes(key)) continue;
    let val = raw;
    if (key === 'email') {
      val = normEmail(raw);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) return res.status(400).json({ error: 'Correo electrónico inválido' });
    }
    sets.push(`${key} = $${i++}`);
    values.push(val);
  }
  if (sets.length === 0 && !wantsLocation) return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
  values.push(req.tenant.tenantId);
  let txc = null;
  try {
    // Cambiar el correo de acceso exige la contraseña actual (los demás campos no)
    if (allowed.includes('email') && req.body.email !== undefined) {
      const { rows: cur } = await pool.query('SELECT email, password_hash FROM tenants WHERE id = $1', [req.tenant.tenantId]);
      if (!cur[0]) return res.status(404).json({ error: 'Tenant no encontrado' });
      if (normEmail(req.body.email) !== normEmail(cur[0].email)) {
        const pw = req.body.currentPassword;
        if (typeof pw !== 'string' || !pw) return res.status(401).json({ error: 'Escribe tu contraseña actual para cambiar el correo' });
        const bad = await checkCurrentPassword(req.tenant.tenantId, pw, cur[0].password_hash);
        if (bad) return res.status(bad[0]).json({ error: bad[1] });
      }
    }
    txc = await pool.connect();
    await txc.query('BEGIN');
    if (wantsLocation) {
      const loc = await applyTenantLocation(txc, req.tenant.tenantId, { country: req.body.country, timezone: req.body.timezone });
      if (!loc) { await txc.query('ROLLBACK'); return res.status(404).json({ error: 'Tenant no encontrado' }); }
    }
    let rows;
    if (sets.length) {
      ({ rows } = await txc.query(
        `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i} RETURNING business_name, full_name, email, country, timezone, whatsapp_number`,
        values));
    } else {
      ({ rows } = await txc.query('SELECT business_name, full_name, email, country, timezone, whatsapp_number FROM tenants WHERE id = $1', [req.tenant.tenantId]));
    }
    await txc.query('COMMIT');
    if (!rows[0]) return res.status(404).json({ error: 'Tenant no encontrado' });
    const out = { success: true, tenant: { ...rows[0], ...locationOf(rows[0]) } };
    // Cambiar el correo del dueño cierra sus sesiones anteriores (token_version): esta recibe un token nuevo
    if (req.user.role === 'owner') {
      const { rows: [ou] } = await pool.query('SELECT * FROM team_users WHERE id = $1', [req.user.id]);
      if (ou && ou.token_version !== req.tenant.tv) {
        out.token = signUserToken(ou);
        if (req.tenant.userId) closeUserSockets(req.tenant.tenantId, ou.id);
      }
    }
    res.json(out);
  } catch (err) {
    if (txc) await txc.query('ROLLBACK').catch(() => {});
    if (err instanceof BadRequest) return res.status(400).json(badRequestBody(err));
    if (err.code === '23505') return res.status(409).json({ error: 'Ese correo ya está en uso por otra cuenta' });
    console.error('profile update error:', err);
    res.status(500).json({ error: 'Error al guardar el perfil' });
  } finally {
    if (txc) txc.release();
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

// ── Respuesta automática fuera de horario: configuración del negocio ──
app.get('/api/tenant/auto-reply', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const { rows } = await pool.query(
      'SELECT auto_reply_enabled, off_hours_message, business_hours, timezone, country FROM tenants WHERE id = $1',
      [req.tenant.tenantId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Tenant no encontrado' });
    const t = rows[0];
    res.json({
      enabled:    !!t.auto_reply_enabled,
      message:    t.off_hours_message || DEFAULT_OFF_HOURS_MESSAGE,
      schedule:   isValidSchedule(t.business_hours) ? t.business_hours : DEFAULT_SCHEDULE,
      timezone:   ops.tzOf(t), // la de la ubicación del negocio (Ajustes → Perfil → País y zona horaria); aquí ya no se cambia
      configured: t.business_hours !== null || t.off_hours_message !== null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al leer la configuración' });
  }
});

app.put('/api/tenant/auto-reply', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const b = req.body || {};
  const sets = [], values = [];
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'enabled debe ser true o false' });
    values.push(b.enabled); sets.push(`auto_reply_enabled = $${values.length}`);
  }
  if (b.message !== undefined) {
    const msg = typeof b.message === 'string' ? b.message.trim() : '';
    if (!msg || msg.length > 1000) return res.status(400).json({ error: 'El mensaje debe tener entre 1 y 1000 caracteres' });
    values.push(msg); sets.push(`off_hours_message = $${values.length}`);
  }
  if (b.schedule !== undefined) {
    if (!isValidSchedule(b.schedule)) return res.status(400).json({ error: 'Horario inválido' });
    const clean = b.schedule.map(d => ({ day: d.day, open: d.open, close: d.close, active: d.active }));
    values.push(JSON.stringify(clean)); sets.push(`business_hours = $${values.length}`);
  }
  // `timezone` se ignora: la zona del negocio solo se fija desde su ubicación (PUT /api/tenant/profile). Un cliente antiguo
  // que aún la mande no falla.
  if (!sets.length) {
    if (b.timezone !== undefined) return res.json({ success: true });
    return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
  }
  values.push(req.tenant.tenantId);
  try {
    await pool.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${values.length}`, values);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar la configuración' });
  }
});

// ══════════════════════════════════════════════════════════════
// API — Conversaciones
// ══════════════════════════════════════════════════════════════

// Sin parámetros: el arreglo de siempre (los 300 chats más recientes). Con limit / before / q: { conversations, nextCursor } (100 por
// página, máx. 200; before = cursor de la página anterior; q busca por nombre o número).
app.get('/api/conversations', requireAuth, async (req, res) => {
  try {
    const q = req.query;
    if (q.limit === undefined && q.before === undefined && q.q === undefined) return res.json(await dbGetConversations(req.tenant.tenantId));
    const text = q.q === undefined ? '' : String(q.q).trim().slice(0, 100);
    res.json(await dbListConversations(req.tenant.tenantId, { limit: q.limit, cursor: q.before, q: text || null }));
  } catch (err) { sendApiError(res, err, 'Chats'); }
});

// Mensajes de un chat. Sin limit/before: todos (tope 2000, los más recientes). Con ellos: paginación hacia atrás, 50 por página
// (máx. 200): { messages (del más antiguo al más reciente), hasMore, nextBefore } — pasa nextBefore como `before` para ver los anteriores.
app.get('/api/conversations/:waId', requireAuth, async (req, res) => {
  if (req.query.limit !== undefined || req.query.before !== undefined) {
    try {
      const tenantId = req.tenant.tenantId;
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const { rows: [c] } = await pool.query('SELECT wa_id, name, platform, ig_sender_id FROM conversations WHERE wa_id = $1 AND tenant_id = $2', [req.params.waId, tenantId]);
      if (!c) return res.status(404).json({ error: 'Conversación no encontrada' });
      const P = [tenantId, req.params.waId];
      let cond = '';
      if (req.query.before !== undefined) {
        const cur = decodeCursor(req.query.before);
        if (!cur || !TS_RE.test(String(cur.t)) || typeof cur.i !== 'string') return res.status(400).json({ error: 'Cursor inválido' });
        P.push(cur.t, cur.i);
        cond = `AND (m.time, m.id) < ($3::timestamp, $4)`;
      }
      const { rows } = await pool.query(`
        SELECT ${MSG_JSON} AS j, ${tsText('m.time')} AS t, m.id FROM messages m
        WHERE m.tenant_id = $1 AND m.wa_id = $2 ${cond} ORDER BY m.time DESC, m.id DESC LIMIT ${limit + 1}`, P);
      const page = rows.slice(0, limit);
      const oldest = page[page.length - 1];
      return res.json({ waId: c.wa_id, name: c.name, platform: c.platform, igSenderId: c.ig_sender_id,
        messages: page.map(r => r.j).reverse(), hasMore: rows.length > limit,
        nextBefore: rows.length > limit && oldest ? encodeCursor({ t: oldest.t, i: oldest.id }) : null });
    } catch (err) { return sendApiError(res, err, 'Mensajes del chat'); }
  }
  try {
    const { rows } = await pool.query(`
      SELECT c.wa_id, c.name, c.platform, c.ig_sender_id, c.last_message_at,
        COALESCE((SELECT json_agg(x.j ORDER BY x.t, x.id) FROM (
          SELECT ${MSG_JSON} AS j, m.time AS t, m.id FROM messages m
          WHERE m.tenant_id = c.tenant_id AND m.wa_id = c.wa_id ORDER BY m.time DESC, m.id DESC LIMIT 2000) x), '[]'::json) AS messages
      FROM conversations c
      WHERE c.wa_id = $1 AND c.tenant_id = $2
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
    const q = req.query;
    const paged = ['limit', 'before', 'status', 'kind', 'deliveryDate', 'q', 'clientId', 'orderId'].some(k => q[k] !== undefined);
    if (!paged) return res.json(await dbGetOrders(req.tenant.tenantId)); // compatibilidad: sin parámetros, el arreglo de siempre (1000 más recientes)
    res.json(await dbListOrders(req.tenant.tenantId, q));
  } catch (err) { sendApiError(res, err, 'Pedidos'); }
});

app.post('/api/orders', requireAuth, async (req, res) => {
  if (!req.body || !req.body.clientName) {
    return res.status(400).json({ error: 'Falta el nombre del cliente' });
  }
  try {
    const order = await dbCreateOrder(req.tenant.tenantId, req.body, req.user);
    if (!order) return res.status(503).json({ error: 'Base de datos no disponible' });
    res.json(order);
  } catch (err) { sendApiError(res, err, 'Crear pedido'); }
});

app.patch('/api/orders/:id', requireAuth, async (req, res) => {
  try {
    const order = await dbUpdateOrder(req.tenant.tenantId, req.params.id, req.body || {}, req.user);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json(order);
  } catch (err) { sendApiError(res, err, 'Editar pedido'); }
});

// ── Ciclo del pedido (Fase 3): convertir presupuesto, anular, devoluciones, saldo a favor ──

// Ejecuta una operación del ciclo sobre un pedido y responde con el pedido completo
const cycleRoute = (label, notFound, op) => async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: notFound });
  const tenantId = req.tenant.tenantId;
  try {
    const out = await inTx(async (c) => {
      const r = await op(c, tenantId, req);
      if (!r) return null;
      return { ...r.extra, order: await fetchOrderFull(c, tenantId, req.params.id) };
    });
    if (!out) return res.status(404).json({ error: notFound });
    res.json(out);
  } catch (err) { sendApiError(res, err, label); }
};
app.post('/api/orders/:id/convert', requireAuth, cycleRoute('Convertir presupuesto', 'Pedido no encontrado',
  async (c, t, req) => (await convertQuoteTx(c, t, req.params.id, req.user)) ? { extra: {} } : null));
app.post('/api/orders/:id/cancel', requireAuth, cycleRoute('Anular pedido', 'Pedido no encontrado',
  async (c, t, req) => (await cancelOrderTx(c, t, req.params.id, req.body, req.user)) ? { extra: {} } : null));
app.post('/api/orders/:id/returns', requireAuth, cycleRoute('Devolución', 'Pedido no encontrado',
  async (c, t, req) => { const r = await createReturnTx(c, t, req.params.id, req.body, req.user); return r && { extra: { creditNote: r.creditNote } }; }));

app.get('/api/orders/:id/returns', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Pedido no encontrado' });
  const tenantId = req.tenant.tenantId;
  try {
    const { rows: ord } = await pool.query('SELECT 1 FROM orders WHERE id = $1 AND tenant_id = $2', [req.params.id, tenantId]);
    if (!ord[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    const [{ rows: notes }, { rows: refs }] = await Promise.all([
      pool.query('SELECT * FROM credit_notes WHERE order_id = $1 AND tenant_id = $2 ORDER BY number LIMIT 500', [req.params.id, tenantId]),
      pool.query('SELECT * FROM refunds WHERE order_id = $1 AND tenant_id = $2 ORDER BY created_at LIMIT 500', [req.params.id, tenantId]),
    ]);
    const cnotes = await mapCreditNoteFull(pool, tenantId, notes);
    await ops.attachByName(pool, tenantId, cnotes, ops.BY_CREATED);
    for (const n of cnotes) await ops.attachByName(pool, tenantId, n.refunds, ops.BY_CREATED);
    res.json({ creditNotes: cnotes, refunds: await ops.attachByName(pool, tenantId, refs.map(mapRefundRow), ops.BY_CREATED) });
  } catch (err) { sendApiError(res, err, 'Devoluciones del pedido'); }
});

// Saldo a favor de un cliente y sus movimientos (el más reciente primero)
app.get('/api/clients/:id/credit', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Cliente no encontrado' });
  const tenantId = req.tenant.tenantId;
  try {
    const { rows: c } = await pool.query('SELECT 1 FROM clients WHERE id = $1 AND tenant_id = $2', [req.params.id, tenantId]);
    if (!c[0]) return res.status(404).json({ error: 'Cliente no encontrado' });
    const [{ rows: [b] }, { rows }] = await Promise.all([
      pool.query('SELECT COALESCE(SUM(amount), 0) AS b FROM client_credit_entries WHERE client_id = $1 AND tenant_id = $2', [req.params.id, tenantId]),
      pool.query(`SELECT e.id, e.amount, e.kind, e.order_id, e.created_at,
          CASE WHEN o.kind = 'quote' THEN 'P-' || lpad(COALESCE(o.quote_number, 0)::text, 4, '0')
               ELSE '#' || lpad(COALESCE(o.tenant_order_number, o.order_number)::text, 4, '0') END AS order_number
        FROM client_credit_entries e LEFT JOIN orders o ON o.id = e.order_id AND o.tenant_id = e.tenant_id
        WHERE e.client_id = $1 AND e.tenant_id = $2 ORDER BY e.created_at DESC, e.id LIMIT 200`, [req.params.id, tenantId]),
    ]);
    res.json({ balance: money2(b.b), entries: rows.map(r => ({
      id: r.id, amount: Number(r.amount), kind: r.kind, orderId: r.order_id, orderNumber: r.order_number, createdAt: r.created_at })) });
  } catch (err) { sendApiError(res, err, 'Saldo a favor'); }
});

// ── Pagos de un pedido ────────────────────────────────────────

app.get('/api/orders/:id/payments', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Pedido no encontrado' });
  const tenantId = req.tenant.tenantId;
  try {
    const { rows: ord } = await pool.query('SELECT * FROM orders WHERE id = $1 AND tenant_id = $2', [req.params.id, tenantId]);
    if (!ord[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    const { rows } = await pool.query(
      'SELECT * FROM payments WHERE order_id = $1 AND tenant_id = $2 ORDER BY paid_at, created_at', [req.params.id, tenantId]);
    const o = mapOrderRow(ord[0]);
    const plist = await ops.attachByName(pool, tenantId, rows.map(mapPaymentRow), ops.BY_EXPENSE);
    res.json({ payments: plist, amountPaid: o.amountPaid, balance: o.balance, payStatus: o.payStatus });
  } catch (err) { sendApiError(res, err, 'Pagos del pedido'); }
});

app.post('/api/orders/:id/payments', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Pedido no encontrado' });
  const tenantId = req.tenant.tenantId;
  try {
    const out = await inTx(async (c) => {
      const r = await addPaymentTx(c, tenantId, req.params.id, req.body, req.user);
      if (r) await ops.withName(c, tenantId, r.payment, ops.BY_EXPENSE);
      return r && { payment: r.payment, order: await fetchOrderFull(c, tenantId, req.params.id) };
    });
    if (!out) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json(out);
  } catch (err) { sendApiError(res, err, 'Registrar pago'); }
});

app.post('/api/payments/:id/void', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Pago no encontrado' });
  const tenantId = req.tenant.tenantId;
  try {
    const out = await inTx(async (c) => {
      const r = await voidPaymentTx(c, tenantId, req.params.id, req.body && req.body.reason, req.user);
      if (r) await ops.withName(c, tenantId, r.payment, ops.BY_EXPENSE);
      return r && { payment: r.payment, order: await fetchOrderFull(c, tenantId, r.order.id) };
    });
    if (!out) return res.status(404).json({ error: 'Pago no encontrado' });
    res.json(out);
  } catch (err) { sendApiError(res, err, 'Anular pago'); }
});

// Cobros del periodo (por día en la zona horaria del negocio). Incluye anulados (con flag `voided`);
// los totales solo cuentan los no anulados, en moneda base.
const PAYMENTS_LIST_LIMIT = 500;
app.get('/api/payments', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const tenantId = req.tenant.tenantId;
  try {
    const tz = await resolveTenantTz(tenantId);
    const { rows: [n] } = await pool.query("SELECT to_char(NOW() AT TIME ZONE $1, 'YYYY-MM-DD') AS today", [tz]);
    // period=today|yesterday|7d|month se resuelve en la zona del negocio; si llegan from/to, mandan esos
    const PERIODS = ['today', 'yesterday', '7d', 'month'];
    const period = req.query.period === undefined || req.query.period === '' ? null : String(req.query.period);
    if (period && !PERIODS.includes(period)) return res.status(400).json({ error: 'Periodo inválido (today, yesterday, 7d o month)' });
    const shiftDay = (d, k) => new Date(Date.parse(d) + k * 86400000).toISOString().slice(0, 10);
    let pFrom = n.today, pTo = n.today;
    if (period === 'yesterday') pFrom = pTo = shiftDay(n.today, -1);
    else if (period === '7d') pFrom = shiftDay(n.today, -6);
    else if (period === 'month') pFrom = n.today.slice(0, 8) + '01';
    const to = req.query.to ? String(req.query.to) : (req.query.from ? n.today : pTo);
    const start = req.query.from ? String(req.query.from) : (req.query.to ? to : pFrom);
    if (!isRealDate(start) || !isRealDate(to)) return res.status(400).json({ error: 'Fechas inválidas (formato YYYY-MM-DD)' });
    if (start > to) return res.status(400).json({ error: 'La fecha inicial debe ser anterior a la final' });
    if ((Date.parse(to) - Date.parse(start)) / 86400000 > 366) return res.status(400).json({ error: 'El rango máximo es de un año' });
    let method = null;
    if (req.query.method !== undefined && req.query.method !== '') {
      method = String(req.query.method);
      if (method.length > 60) return res.status(400).json({ error: 'Método inválido' });
    }
    const endExclusive = new Date(Date.parse(to) + 86400000).toISOString().slice(0, 10);
    const RANGE = 'p.tenant_id = $1 AND p.paid_at >= ($3::timestamp AT TIME ZONE $2) AND p.paid_at < ($4::timestamp AT TIME ZONE $2)';
    // El filtro por método usa el nombre canónico: se buscan los nombres guardados que le corresponden
    let methodList = null;
    if (method) {
      const { rows: ms } = await pool.query(`
        SELECT p.method FROM payments p WHERE ${RANGE}
        UNION SELECT r.method FROM refunds r WHERE r.tenant_id = $1 AND r.created_at >= ($3::timestamp AT TIME ZONE $2) AND r.created_at < ($4::timestamp AT TIME ZONE $2)`,
        [tenantId, tz, start, endExclusive]);
      methodList = rawMethodsFor(ms.map(r => r.method), method);
    }
    const W = `${RANGE} AND ($5::text[] IS NULL OR p.method = ANY($5::text[]))`;
    const P = [tenantId, tz, start, endExclusive, methodList];
    // Reembolsos del mismo rango y método (su fecha es created_at)
    const RW = `r.tenant_id = $1 AND r.created_at >= ($3::timestamp AT TIME ZONE $2) AND r.created_at < ($4::timestamp AT TIME ZONE $2)
      AND ($5::text[] IS NULL OR r.method = ANY($5::text[]))`;
    const [list, refList, totals, cnt, base] = await Promise.all([
      pool.query(`
        SELECT p.*, COALESCE(o.tenant_order_number, o.order_number) AS order_num, o.client_name
        FROM payments p JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
        WHERE ${W} ORDER BY p.paid_at DESC, p.created_at DESC LIMIT ${PAYMENTS_LIST_LIMIT + 1}`, P),
      pool.query(`
        SELECT r.*, COALESCE(o.tenant_order_number, o.order_number) AS order_num, o.client_name
        FROM refunds r JOIN orders o ON o.id = r.order_id AND o.tenant_id = r.tenant_id
        WHERE ${RW} ORDER BY r.created_at DESC LIMIT ${PAYMENTS_LIST_LIMIT + 1}`, P),
      // Cobrado = pagos − reembolsos; el saldo a favor no es dinero nuevo: fuera de ambos lados
      pool.query(`
        SELECT method, SUM(total)::float AS total, SUM(n)::int AS n FROM (
          SELECT p.method, COALESCE(SUM(p.amount_base), 0) AS total, COUNT(*) AS n
          FROM payments p WHERE ${W} AND p.voided_at IS NULL AND p.method <> $6 GROUP BY p.method
          UNION ALL
          SELECT r.method, -COALESCE(SUM(r.amount_base), 0), 0
          FROM refunds r WHERE ${RW} AND r.method <> $6 GROUP BY r.method
        ) x GROUP BY method ORDER BY total DESC, method`, [...P, CREDIT_METHOD]),
      pool.query(`SELECT (SELECT COUNT(*) FROM payments p WHERE ${W}) + (SELECT COUNT(*) FROM refunds r WHERE ${RW}) AS n`, P),
      pool.query('SELECT base_currency FROM tenants WHERE id = $1', [tenantId]),
    ]);
    const mapRefundAsPayment = (r) => ({
      id: r.id, kind: 'refund', orderId: r.order_id, creditNoteId: r.credit_note_id, clientId: null,
      amount: -Number(r.amount), currency: r.currency, exchangeRate: Number(r.exchange_rate), amountBase: -Number(r.amount_base),
      method: r.method, reference: r.reference, paidAt: r.created_at, note: r.reason, createdAt: r.created_at, createdBy: r.created_by,
      voided: false, voidedAt: null, voidReason: null,
      orderNumber: '#' + String(r.order_num).padStart(4, '0'), clientName: r.client_name || null,
    });
    const merged = [...list.rows.map(p => ({ ...mapPaymentRow(p), kind: 'payment' })), ...refList.rows.map(mapRefundAsPayment)]
      .sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
    await ops.attachByName(pool, tenantId, merged.slice(0, PAYMENTS_LIST_LIMIT), ops.BY_EXPENSE);
    const truncated = list.rows.length > PAYMENTS_LIST_LIMIT || refList.rows.length > PAYMENTS_LIST_LIMIT || merged.length > PAYMENTS_LIST_LIMIT;
    const byMethod = mergeMethodTotals(totals.rows);
    res.json({
      timezone: tz, from: start, to, baseCurrency: base.rows[0] ? base.rows[0].base_currency : 'USD',
      payments: merged.slice(0, PAYMENTS_LIST_LIMIT),
      truncated, limit: PAYMENTS_LIST_LIMIT, totalCount: Number(cnt.rows[0].n),
      totals: { total: money2(byMethod.reduce((a, r) => a + r.total, 0)), count: byMethod.reduce((a, r) => a + r.count, 0), byMethod },
    });
  } catch (err) { sendApiError(res, err, 'Cobros'); }
});

// Historial del pedido (creado, editado, entrega, pagos…), del más antiguo al más reciente
app.get('/api/orders/:id/events', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Pedido no encontrado' });
  const tenantId = req.tenant.tenantId;
  try {
    const { rows: ord } = await pool.query('SELECT 1 FROM orders WHERE id = $1 AND tenant_id = $2', [req.params.id, tenantId]);
    if (!ord[0]) return res.status(404).json({ error: 'Pedido no encontrado' });
    const { rows } = await pool.query(
      'SELECT id, type, data, created_by, created_by_user_id, created_at FROM order_events WHERE order_id = $1 AND tenant_id = $2 ORDER BY created_at, seq LIMIT 500',
      [req.params.id, tenantId]);
    res.json({ events: await ops.attachByName(pool, tenantId, rows.map(r => ({
      id: r.id, type: r.type, data: r.data, createdBy: r.created_by, createdByUserId: r.created_by_user_id || null, createdAt: r.created_at })), ops.BY_CREATED) });
  } catch (err) { sendApiError(res, err, 'Historial del pedido'); }
});

// ── Fase 4A: gastos y cierre de caja ──────────────────────────
// Rango de días en la zona del negocio: period=today|yesterday|7d|month o from/to (YYYY-MM-DD, máx. un año)
async function resolveDayRange(query, tz, defaultPeriod = 'month') {
  const { rows: [n] } = await pool.query("SELECT to_char(NOW() AT TIME ZONE $1, 'YYYY-MM-DD') AS today", [tz]);
  const PERIODS = ['today', 'yesterday', '7d', 'month'];
  const period = query.period === undefined || query.period === '' ? (query.from || query.to ? null : defaultPeriod) : String(query.period);
  if (period && !PERIODS.includes(period)) throw new BadRequest('Periodo inválido (today, yesterday, 7d o month)');
  let pFrom = n.today, pTo = n.today;
  if (period === 'yesterday') pFrom = pTo = ops.shiftDay(n.today, -1);
  else if (period === '7d') pFrom = ops.shiftDay(n.today, -6);
  else if (period === 'month') pFrom = n.today.slice(0, 8) + '01';
  const to = query.to ? String(query.to) : (query.from ? n.today : pTo);
  const start = query.from ? String(query.from) : (query.to ? to : pFrom);
  if (!isRealDate(start) || !isRealDate(to)) throw new BadRequest('Fechas inválidas (formato YYYY-MM-DD)');
  if (start > to) throw new BadRequest('La fecha inicial debe ser anterior a la final');
  if ((Date.parse(to) - Date.parse(start)) / 86400000 > 366) throw new BadRequest('El rango máximo es de un año');
  return { start, to, today: n.today };
}

// Gastos y cierre de caja: desde el plan Pro (en Básico, 403 plan_required). Lo comprueba el servidor, no solo el menú.
const planGate = (message) => (req, res, next) =>
  req.tenant.plan === 'basic' ? res.status(403).json({ error: 'plan_required', message }) : next();
const expensesPlan = planGate('Los gastos están disponibles desde el plan Pro.');
const cashPlan = planGate('El cierre de caja está disponible desde el plan Pro.');

const EXPENSES_LIST_LIMIT = 500;
app.get('/api/expenses', requireAuth, expensesPlan, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const tenantId = req.tenant.tenantId;
  try {
    const tz = await resolveTenantTz(tenantId);
    const { start, to } = await resolveDayRange(req.query, tz);
    let category = null;
    if (req.query.category !== undefined && req.query.category !== '') {
      category = String(req.query.category);
      if (category.length > 60) throw new BadRequest('Categoría inválida');
    }
    const W = 'e.tenant_id = $1 AND e.spent_on >= $2::date AND e.spent_on <= $3::date AND ($4::text IS NULL OR lower(e.category) = lower($4))';
    const P = [tenantId, start, to, category];
    const [list, byCat, cnt, base, cats] = await Promise.all([
      pool.query(`SELECT e.* FROM expenses e WHERE ${W} ORDER BY e.spent_on DESC, e.created_at DESC LIMIT ${EXPENSES_LIST_LIMIT + 1}`, P),
      pool.query(`SELECT e.category, SUM(e.amount_base)::float AS total, COUNT(*)::int AS n FROM expenses e
        WHERE ${W} AND e.voided_at IS NULL GROUP BY e.category ORDER BY total DESC, e.category`, P),
      pool.query(`SELECT COUNT(*)::int AS n, (COUNT(*) FILTER (WHERE e.voided_at IS NOT NULL))::int AS voided FROM expenses e WHERE ${W}`, P),
      pool.query('SELECT base_currency FROM tenants WHERE id = $1', [tenantId]),
      ops.getExpenseCategories(pool, tenantId),
    ]);
    res.json({
      timezone: tz, from: start, to, baseCurrency: base.rows[0] ? base.rows[0].base_currency : 'USD',
      expenses: await ops.attachByName(pool, tenantId, list.rows.slice(0, EXPENSES_LIST_LIMIT).map(ops.mapExpenseRow), ops.BY_EXPENSE),
      truncated: list.rows.length > EXPENSES_LIST_LIMIT, limit: EXPENSES_LIST_LIMIT, totalCount: cnt.rows[0].n, voidedCount: cnt.rows[0].voided,
      total: money2(byCat.rows.reduce((a, r) => a + r.total, 0)),
      byCategory: byCat.rows.map(r => ({ category: r.category, total: money2(r.total), count: r.n })),
      categories: cats,
    });
  } catch (err) { sendApiError(res, err, 'Gastos'); }
});

app.post('/api/expenses', requireAuth, expensesPlan, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const expense = await inTx(c => ops.addExpenseTx(c, req.tenant.tenantId, req.body, req.user));
    res.json({ expense });
  } catch (err) { sendApiError(res, err, 'Registrar gasto'); }
});

app.post('/api/expenses/:id/void', requireAuth, expensesPlan, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Gasto no encontrado' });
  try {
    const expense = await inTx(c => ops.voidExpenseTx(c, req.tenant.tenantId, req.params.id, req.body && req.body.reason, req.user));
    if (!expense) return res.status(404).json({ error: 'Gasto no encontrado' });
    res.json({ expense });
  } catch (err) { sendApiError(res, err, 'Anular gasto'); }
});

// Cierre de caja: lista de cierres de un rango (el más reciente primero), con las reaperturas
app.get('/api/cash', requireAuth, cashPlan, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const tenantId = req.tenant.tenantId;
  try {
    const tz = await resolveTenantTz(tenantId);
    const { start, to } = await resolveDayRange(req.query, tz);
    const [{ rows }, { rows: [bt] }] = await Promise.all([
      pool.query('SELECT * FROM cash_closings WHERE tenant_id = $1 AND day >= $2::date AND day <= $3::date ORDER BY day DESC, closed_at DESC LIMIT 401', [tenantId, start, to]),
      pool.query('SELECT base_currency FROM tenants WHERE id = $1', [tenantId]),
    ]);
    const base = (bt && bt.base_currency) || 'USD';
    res.json({ timezone: tz, baseCurrency: base, from: start, to, closings: await ops.attachByName(pool, tenantId, rows.slice(0, 400).map(r => ops.mapClosing(r, base)), ops.BY_CLOSING), truncated: rows.length > 400 });
  } catch (err) { sendApiError(res, err, 'Cierres de caja'); }
});
app.get('/api/cash/:day', requireAuth, cashPlan, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try { res.json(await ops.getCashDay(pool, req.tenant.tenantId, req.params.day)); }
  catch (err) { sendApiError(res, err, 'Caja del día'); }
});
app.post('/api/cash/:day/close', requireAuth, cashPlan, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const tenantId = req.tenant.tenantId;
  try {
    res.json(await inTx(async (c) => { await ops.closeCashDay(c, tenantId, req.params.day, req.body, req.user); return ops.getCashDay(c, tenantId, req.params.day); }));
  } catch (err) { sendApiError(res, err, 'Cerrar caja'); }
});
// Reabrir (y ver qué días siguen cerrados) se permite en TODOS los planes: quien baja de plan con cierres vigentes no puede
// quedar bloqueado. La lista de días cerrados vive en `/api/cash-closed`.
app.get('/api/cash-closed', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const { rows } = await pool.query(
      `SELECT to_char(day, 'YYYY-MM-DD') AS day, closed_at FROM cash_closings
       WHERE tenant_id = $1 AND reopened_at IS NULL ORDER BY day DESC LIMIT 200`, [req.tenant.tenantId]);
    res.json({ days: rows.map(r => ({ day: r.day, closedAt: r.closed_at })) });
  } catch (err) { sendApiError(res, err, 'Días con caja cerrada'); }
});
app.post('/api/cash/:day/reopen', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const tenantId = req.tenant.tenantId;
  try {
    res.json(await inTx(async (c) => { await ops.reopenCashDay(c, tenantId, req.params.day, req.body, req.user); return ops.getCashDay(c, tenantId, req.params.day); }));
  } catch (err) { sendApiError(res, err, 'Reabrir caja'); }
});

// ══════════════════════════════════════════════════════════════
// API — Equipo (Fase 4B): solo el dueño. Plan Pro o Business para crear y gestionar (en Básico solo se puede consultar
// y resolver el límite si quedaron usuarios de más tras bajar de plan). Nada se borra: se desactiva.
// ══════════════════════════════════════════════════════════════
const teamPlan = planGate('El equipo está disponible desde el plan Pro.');
const TEAM_COLS = 'id, name, email, role, active, must_change_password, temp_password_expires_at, created_at, deactivated_at, last_login_at';
function mapTeamUser(r) {
  return {
    id: r.id, name: r.name, email: r.email, role: r.role, roleLabel: team.ROLE_LABEL[r.role] || r.role, isOwner: r.role === 'owner',
    active: !!r.active, mustChangePassword: !!r.must_change_password, tempPasswordExpiresAt: r.temp_password_expires_at || null,
    createdAt: r.created_at, deactivatedAt: r.deactivated_at || null, lastLoginAt: r.last_login_at || null,
  };
}
async function teamOverview(db, tenantId) {
  const { rows: [t] } = await db.query('SELECT plan, team_over_limit_since FROM tenants WHERE id = $1', [tenantId]);
  const { rows } = await db.query(`SELECT ${TEAM_COLS} FROM team_users WHERE tenant_id = $1 ORDER BY (role = 'owner') DESC, created_at, id`, [tenantId]);
  const limit = team.planLimit(t.plan);
  const activeCount = rows.filter(r => r.active).length;
  const since = t.team_over_limit_since ? new Date(t.team_over_limit_since) : null;
  return {
    plan: t.plan, limit, activeCount, users: rows.map(mapTeamUser),
    overLimit: activeCount > limit
      ? { since: (since || new Date()).toISOString(), deadline: new Date((since || new Date()).getTime() + team.OVER_LIMIT_GRACE_DAYS * 86400000).toISOString(), limit, activeCount }
      : null,
    roles: ['manager', 'seller'].map(r => ({ role: r, label: team.ROLE_LABEL[r] })),
  };
}
const cleanTeamName = (v) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) throw new BadRequest('El nombre es obligatorio');
  if (s.length > 80) throw new BadRequest('El nombre es demasiado largo (máx. 80 caracteres)');
  return s;
};
const cleanTeamRole = (v) => {
  if (v !== 'manager' && v !== 'seller') throw new BadRequest('El rol debe ser «manager» (encargado) o «seller» (vendedor)');
  return v;
};
// Contraseña temporal: en cuentas reales caduca a los 7 días y hay que cambiarla al entrar. En una demo no (la demo no puede
// cambiar contraseñas), así que la clave que se muestra sirve mientras dure la demo.
async function newTempCredentials(isDemo) {
  const password = team.generateTempPassword();
  return { password, hash: await bcrypt.hash(password, 10), mustChange: !isDemo,
    expires: isDemo ? null : new Date(Date.now() + team.TEMP_PASSWORD_DAYS * 86400000) };
}
const loadTeamTarget = async (db, tenantId, id, selfId) => {
  const { rows: [u] } = await db.query(`SELECT ${TEAM_COLS} FROM team_users WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [id, tenantId]);
  if (!u) return null;
  if (u.role === 'owner') throw new BadRequest('No se puede modificar al dueño del negocio');
  if (u.id === selfId) throw new BadRequest('No puedes modificar tu propio usuario desde aquí');
  return u;
};
// Desactiva a todos los usuarios activos no dueños que NO estén en keepIds (dentro de la transacción de quien llama)
// y devuelve los ids desactivados. Valida que keepIds sean usuarios activos de ESTE negocio y quepan en el límite.
async function applyKeepUsers(c, tenantId, limit, keepIds) {
  if (!Array.isArray(keepIds) || keepIds.some(k => typeof k !== 'string' || !UUID_RE.test(k))) throw new BadRequest('keepUserIds debe ser una lista de usuarios');
  const keep = [...new Set(keepIds)];
  if (keep.length > Math.max(0, limit - 1)) throw new BadRequest(`Con este plan caben ${limit} usuarios contando al dueño: elige como máximo ${Math.max(0, limit - 1)} más`);
  const { rows: act } = await c.query(`SELECT id FROM team_users WHERE tenant_id = $1 AND active AND role <> 'owner'`, [tenantId]);
  const activeIds = new Set(act.map(r => r.id));
  if (keep.some(k => !activeIds.has(k))) throw new BadRequest('Algún usuario elegido no existe o no está activo');
  const drop = act.map(r => r.id).filter(id => !keep.includes(id));
  if (drop.length) {
    await c.query(`UPDATE team_users SET active = false, deactivated_at = now(), token_version = token_version + 1
      WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND role <> 'owner'`, [tenantId, drop]);
  }
  return drop;
}
// Marca el plazo de 3 días si, tras bajar el plan, hay más usuarios activos que los del plan. No hace nada si cabe.
async function markTeamOverLimit(tenantId) {
  await pool.query(`UPDATE tenants t SET team_over_limit_since = now() WHERE t.id = $1 AND t.team_over_limit_since IS NULL
    AND (SELECT count(*) FROM team_users u WHERE u.tenant_id = t.id AND u.active) >
        CASE t.plan WHEN 'business' THEN ${team.PLAN_USER_LIMIT.business} WHEN 'pro' THEN ${team.PLAN_USER_LIMIT.pro} ELSE ${team.PLAN_USER_LIMIT.basic} END`, [tenantId]);
}
// Tarea periódica (al arrancar y cada hora): marca los negocios con usuarios de más y desactiva a los más recientes de los que
// ya pasaron el plazo. Nada se borra.
async function teamLimitSweep() {
  if (!dbReady) return;
  try {
    await pool.query(`UPDATE tenants t SET team_over_limit_since = now() WHERE t.team_over_limit_since IS NULL
      AND (SELECT count(*) FROM team_users u WHERE u.tenant_id = t.id AND u.active) >
          CASE t.plan WHEN 'business' THEN ${team.PLAN_USER_LIMIT.business} WHEN 'pro' THEN ${team.PLAN_USER_LIMIT.pro} ELSE ${team.PLAN_USER_LIMIT.basic} END`);
    const { rows } = await pool.query(`SELECT id FROM tenants WHERE team_over_limit_since IS NOT NULL
      AND team_over_limit_since <= now() - make_interval(days => ${team.OVER_LIMIT_GRACE_DAYS}) LIMIT 200`);
    for (const t of rows) await enforceTeamLimit(t.id);
  } catch (err) { console.error('⚠️  Revisión de límites del equipo:', err.message); }
}

app.get('/api/team', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    const out = await teamOverview(pool, req.tenant.tenantId);
    // En Básico no hay equipo, salvo que queden usuarios de una bajada de plan (hay que poder verlos y elegir)
    if (req.tenant.plan === 'basic' && out.users.length <= 1) return res.status(403).json({ error: 'plan_required', message: 'El equipo está disponible desde el plan Pro.' });
    res.json({ ...out, canManage: req.tenant.plan !== 'basic' });
  } catch (err) { sendApiError(res, err, 'Equipo'); }
});

app.post('/api/team', requireAuth, teamPlan, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const tenantId = req.tenant.tenantId, b = req.body || {};
  try {
    const name = cleanTeamName(b.name), role = cleanTeamRole(b.role), email = normEmail(b.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new BadRequest('Correo electrónico inválido');
    const cred = await newTempCredentials(!!req.tenant.isDemo);
    const out = await inTx(async (c) => {
      const { rows: [t] } = await c.query('SELECT plan FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
      const limit = team.planLimit(t.plan);
      const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM team_users WHERE tenant_id = $1 AND active', [tenantId]);
      if (n.n >= limit) throw new TeamError('team_limit', `Tu plan permite ${limit} usuarios contando al dueño. Desactiva a alguien o sube de plan.`, { limit });
      await c.query('SAVEPOINT new_user'); // el correo repetido es esperable: se responde 400 sin romper la transacción
      try {
        const { rows: [u] } = await c.query(`
          INSERT INTO team_users (tenant_id, name, email, password_hash, role, must_change_password, temp_password_expires_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${TEAM_COLS}`, [tenantId, name, email, cred.hash, role, cred.mustChange, cred.expires]);
        return u;
      } catch (e) {
        if (e.code === '23505') { await c.query('ROLLBACK TO SAVEPOINT new_user'); throw new BadRequest('Ese correo ya está en uso por otro usuario o negocio'); }
        throw e;
      }
    });
    // La contraseña se devuelve UNA vez: no se guarda en claro
    res.json({ user: mapTeamUser(out), tempPassword: cred.password, tempPasswordExpiresAt: cred.expires });
  } catch (err) { sendApiError(res, err, 'Crear usuario del equipo'); }
});

app.patch('/api/team/:id', requireAuth, teamPlan, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Usuario no encontrado' });
  const tenantId = req.tenant.tenantId, b = req.body || {};
  try {
    const name = b.name !== undefined ? cleanTeamName(b.name) : null;
    const role = b.role !== undefined ? cleanTeamRole(b.role) : null;
    if (b.active !== undefined && typeof b.active !== 'boolean') throw new BadRequest('«active» debe ser verdadero o falso');
    if (name === null && role === null && b.active === undefined) throw new BadRequest('No hay cambios para guardar');
    const out = await inTx(async (c) => {
      const { rows: [t] } = await c.query('SELECT plan FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
      const u = await loadTeamTarget(c, tenantId, req.params.id, req.user.id);
      if (!u) return null;
      let bump = false;
      if (b.active === true && !u.active) {
        const limit = team.planLimit(t.plan);
        const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM team_users WHERE tenant_id = $1 AND active', [tenantId]);
        if (n.n >= limit) throw new TeamError('team_limit', `Tu plan permite ${limit} usuarios contando al dueño. Desactiva a alguien o sube de plan.`, { limit });
      }
      if (b.active === false && u.active) bump = true; // desactivar cierra sus sesiones al instante
      const { rows: [r] } = await c.query(`
        UPDATE team_users SET name = COALESCE($3, name), role = COALESCE($4, role),
          active = COALESCE($5, active),
          deactivated_at = CASE WHEN $5::boolean = false AND active THEN now() WHEN $5::boolean = true THEN NULL ELSE deactivated_at END,
          token_version = token_version + $6
        WHERE id = $1 AND tenant_id = $2 RETURNING ${TEAM_COLS}`, [req.params.id, tenantId, name, role, b.active === undefined ? null : b.active, bump ? 1 : 0]);
      return { user: r, bump, roleChanged: role !== null && role !== u.role };
    });
    if (!out) return res.status(404).json({ error: 'Usuario no encontrado' });
    // Sesiones abiertas: desactivar las cierra; un cambio de rol ya vale en la siguiente petición (el rol se lee de la base) y se
    // avisa por el socket para que su pantalla cambie sin volver a entrar
    if (out.bump) closeUserSockets(tenantId, out.user.id);
    else if (out.roleChanged) {
      const clients = tenantClients.get(String(tenantId));
      if (clients) for (const ws of clients) if (ws.userId === out.user.id && ws.readyState === 1) ws.send(JSON.stringify({ type: 'role_changed', role: out.user.role }));
    }
    res.json({ user: mapTeamUser(out.user) });
  } catch (err) { sendApiError(res, err, 'Editar usuario del equipo'); }
});

app.post('/api/team/:id/reset-password', requireAuth, teamPlan, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Usuario no encontrado' });
  const tenantId = req.tenant.tenantId;
  try {
    const cred = await newTempCredentials(!!req.tenant.isDemo);
    const out = await inTx(async (c) => {
      const u = await loadTeamTarget(c, tenantId, req.params.id, req.user.id);
      if (!u) return null;
      const { rows: [r] } = await c.query(`UPDATE team_users SET password_hash = $3, must_change_password = $4, temp_password_expires_at = $5,
        token_version = token_version + 1 WHERE id = $1 AND tenant_id = $2 RETURNING ${TEAM_COLS}`, [req.params.id, tenantId, cred.hash, cred.mustChange, cred.expires]);
      return r;
    });
    if (!out) return res.status(404).json({ error: 'Usuario no encontrado' });
    closeUserSockets(tenantId, out.id);
    res.json({ user: mapTeamUser(out), tempPassword: cred.password, tempPasswordExpiresAt: cred.expires });
  } catch (err) { sendApiError(res, err, 'Restablecer contraseña del usuario'); }
});

// El dueño elige a quién mantener cuando hay más usuarios activos que los del plan (tras una bajada de plan)
app.post('/api/team/resolve-limit', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const tenantId = req.tenant.tenantId;
  try {
    const dropped = await inTx(async (c) => {
      const { rows: [t] } = await c.query('SELECT plan FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
      const limit = team.planLimit(t.plan);
      const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM team_users WHERE tenant_id = $1 AND active', [tenantId]);
      if (n.n <= limit) throw new BadRequest('No hay usuarios de más: tu equipo cabe en el plan');
      const drop = await applyKeepUsers(c, tenantId, limit, req.body && req.body.keepUserIds);
      await c.query('UPDATE tenants SET team_over_limit_since = NULL WHERE id = $1', [tenantId]);
      return drop;
    });
    for (const id of dropped) closeUserSockets(tenantId, id);
    res.json({ ...(await teamOverview(pool, tenantId)), deactivated: dropped.length });
  } catch (err) { sendApiError(res, err, 'Resolver límite del equipo'); }
});

// ── Ajustes del negocio: métodos de pago, entrega y moneda base ──

function cleanPaymentMethods(v) {
  if (!Array.isArray(v)) throw new BadRequest('Los métodos de pago deben ser una lista');
  if (v.length > 20) throw new BadRequest('Máximo 20 métodos de pago');
  const seen = new Set();
  return v.map(m => {
    if (!m || typeof m !== 'object' || Array.isArray(m)) throw new BadRequest('Método de pago inválido');
    const id = String(m.id ?? '').trim();
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new BadRequest('Método de pago: id inválido');
    if (seen.has(id)) throw new BadRequest('Método de pago: id repetido');
    seen.add(id);
    const name = String(m.name ?? '').trim();
    if (!name || name.length > 60) throw new BadRequest('Método de pago: el nombre es obligatorio (máx. 60 caracteres)');
    if (m.enabled !== undefined && typeof m.enabled !== 'boolean') throw new BadRequest('Método de pago: "enabled" debe ser verdadero o falso');
    const details = {};
    if (m.details !== undefined && m.details !== null) {
      if (typeof m.details !== 'object' || Array.isArray(m.details)) throw new BadRequest('Método de pago: detalles inválidos');
      const entries = Object.entries(m.details);
      if (entries.length > 12) throw new BadRequest('Método de pago: demasiados detalles');
      for (const [k, val] of entries) {
        if (k.length > 40 || typeof val !== 'string' || val.length > 200) throw new BadRequest('Método de pago: cada detalle es texto de hasta 200 caracteres');
        details[k] = val;
      }
    }
    return { id, name, enabled: m.enabled !== false, details };
  });
}

// Lista blanca: claves motorizado|retiro|encomienda|plataformas; cada una { enabled?, label?, items? }.
// Todo lo demás (otra clave, otro tipo) → 400. El SPA pinta estos textos: nunca se guarda algo que no sea texto.
const DELIVERY_KEYS = ['motorizado', 'retiro', 'encomienda', 'plataformas'];
function cleanDeliveryMethods(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadRequest('Los métodos de entrega deben ser un objeto');
  const out = {};
  for (const [key, val] of Object.entries(v)) {
    if (!DELIVERY_KEYS.includes(key)) throw new BadRequest(`Método de entrega desconocido: "${key.slice(0, 40)}"`);
    if (!val || typeof val !== 'object' || Array.isArray(val)) throw new BadRequest(`Método de entrega "${key}" inválido`);
    const m = {};
    for (const [k, x] of Object.entries(val)) {
      if (k === 'enabled') {
        if (typeof x !== 'boolean') throw new BadRequest(`Entrega "${key}": "enabled" debe ser verdadero o falso`);
        m.enabled = x;
      } else if (k === 'label') {
        if (typeof x !== 'string' || x.trim().length > 60) throw new BadRequest(`Entrega "${key}": el nombre es texto de hasta 60 caracteres`);
        m.label = x.trim();
      } else if (k === 'items') {
        if (!Array.isArray(x) || x.length > 30) throw new BadRequest(`Entrega "${key}": "items" es una lista de hasta 30 textos`);
        m.items = x.map(it => {
          if (typeof it !== 'string' || it.trim().length > 60) throw new BadRequest(`Entrega "${key}": cada elemento es texto de hasta 60 caracteres`);
          return it.trim();
        });
      } else throw new BadRequest(`Entrega "${key}": campo desconocido "${k.slice(0, 40)}"`);
    }
    out[key] = m;
  }
  return out;
}

// Impuesto: { enabled, rate 0–100 (2 decimales), label ≤ 30 (por defecto "IVA") }. Se suma ENCIMA de los artículos.
function cleanTax(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new BadRequest('El impuesto debe ser un objeto');
  for (const k of Object.keys(v)) if (!['enabled', 'rate', 'label'].includes(k)) throw new BadRequest(`Impuesto: campo desconocido "${k.slice(0, 40)}"`);
  if (typeof v.enabled !== 'boolean') throw new BadRequest('Impuesto: "enabled" debe ser verdadero o falso');
  let rate = 0;
  if (v.rate !== undefined && v.rate !== null && v.rate !== '') {
    rate = payNum(v.rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new BadRequest('Impuesto: la tasa debe estar entre 0 y 100');
    rate = Math.round(rate * 100) / 100;
  } else if (v.enabled) throw new BadRequest('Impuesto: indica la tasa (entre 0 y 100)');
  let label = DEFAULT_TAX.label;
  if (v.label !== undefined && v.label !== null) {
    if (typeof v.label !== 'string' || v.label.trim().length > 30) throw new BadRequest('Impuesto: el nombre es texto de hasta 30 caracteres');
    label = v.label.trim() || DEFAULT_TAX.label;
  }
  return { enabled: v.enabled, rate, label };
}
// Zonas de entrega: [{ name ≤ 60, cost ≥ 0 opcional }], máximo 50
function cleanZones(v) {
  if (!Array.isArray(v)) throw new BadRequest('Las zonas deben ser una lista');
  if (v.length > 50) throw new BadRequest('Máximo 50 zonas');
  const seen = new Set();
  return v.map(z => {
    if (!z || typeof z !== 'object' || Array.isArray(z)) throw new BadRequest('Zona inválida');
    for (const k of Object.keys(z)) if (!['name', 'cost'].includes(k)) throw new BadRequest(`Zona: campo desconocido "${k.slice(0, 40)}"`);
    const name = typeof z.name === 'string' ? z.name.trim() : '';
    if (!name || name.length > 60) throw new BadRequest('Zona: el nombre es obligatorio (máx. 60 caracteres)');
    if (seen.has(name.toLowerCase())) throw new BadRequest(`Zona repetida: "${name}"`);
    seen.add(name.toLowerCase());
    const out = { name };
    if (z.cost !== undefined && z.cost !== null && z.cost !== '') {
      const c = payNum(z.cost);
      if (!Number.isFinite(c) || c < 0 || c > MAX_MONEY) throw new BadRequest('Zona: el costo debe ser 0 o más');
      out.cost = Math.round(c * 100) / 100;
    }
    return out;
  });
}

// ¿Hay datos en moneda base que un cambio de moneda dejaría mal? Pagos, gastos, reembolsos, notas de crédito, cierres de caja,
// costos o pedidos con total (cambiar la etiqueta sin convertir descuadraría los totales).
async function baseCurrencyInUse(db, tenantId) {
  const { rows: [r] } = await db.query(`SELECT (
      EXISTS (SELECT 1 FROM payments WHERE tenant_id = $1) OR EXISTS (SELECT 1 FROM expenses WHERE tenant_id = $1)
      OR EXISTS (SELECT 1 FROM refunds WHERE tenant_id = $1) OR EXISTS (SELECT 1 FROM cash_closings WHERE tenant_id = $1)
      OR EXISTS (SELECT 1 FROM credit_notes WHERE tenant_id = $1) OR EXISTS (SELECT 1 FROM orders WHERE tenant_id = $1 AND total_price > 0)
      OR EXISTS (SELECT 1 FROM catalog_products WHERE tenant_id = $1 AND cost IS NOT NULL)
      OR EXISTS (SELECT 1 FROM orders o JOIN order_items oi ON oi.order_id = o.id AND oi.tenant_id = o.tenant_id
                 WHERE o.tenant_id = $1 AND oi.unit_cost IS NOT NULL)) AS x`, [tenantId]);
  return r.x;
}
const BASE_CURRENCY_LOCKED_MSG = 'No se puede cambiar la moneda base: ya hay pagos, pedidos con total, gastos, reembolsos, notas de crédito, cierres de caja o costos registrados';

app.get('/api/tenant/settings', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const tenantId = req.tenant.tenantId;
  try {
    const { rows } = await pool.query(`
      SELECT t.base_currency, t.country, t.timezone, s.payment_methods, s.delivery_methods, s.tax, s.zones, s.expense_categories
      FROM tenants t LEFT JOIN tenant_settings s ON s.tenant_id = t.id WHERE t.id = $1`, [tenantId]);
    const r = rows[0] || {};
    res.json({
      baseCurrency: r.base_currency || 'USD', paymentMethods: r.payment_methods || [], deliveryMethods: r.delivery_methods || {},
      tax: mapTax(r.tax), zones: Array.isArray(r.zones) ? r.zones : [], ...locationOf(r), // country, timezone, timezoneOptions
      expenseCategories: Array.isArray(r.expense_categories) && r.expense_categories.length ? r.expense_categories : ops.DEFAULT_EXPENSE_CATEGORIES,
      canChangeBaseCurrency: !(await baseCurrencyInUse(pool, tenantId)), currencies: BASE_CURRENCIES,
    });
  } catch (err) { sendApiError(res, err, 'Ajustes'); }
});

app.put('/api/tenant/settings', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const tenantId = req.tenant.tenantId;
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const pm = b.paymentMethods !== undefined ? cleanPaymentMethods(b.paymentMethods) : null;
    const dm = b.deliveryMethods !== undefined ? cleanDeliveryMethods(b.deliveryMethods) : null;
    let cur = null;
    if (b.baseCurrency !== undefined) {
      cur = String(b.baseCurrency).trim().toUpperCase();
      if (!BASE_CURRENCIES.includes(cur)) throw new BadRequest('Moneda base inválida');
      // Cambiar la moneda base es del dueño: un encargado puede reenviar la actual sin problema
      if (req.user.role !== 'owner') {
        const { rows: [cb] } = await pool.query('SELECT base_currency FROM tenants WHERE id = $1', [tenantId]);
        if (!cb || cb.base_currency !== cur) return res.status(403).json({ error: 'role_forbidden', message: 'Solo el dueño puede cambiar la moneda base.' });
      }
    }
    const tax = b.tax !== undefined ? cleanTax(b.tax) : null;
    const zones = b.zones !== undefined ? cleanZones(b.zones) : null;
    if (b.expenseCategories !== undefined && req.tenant.plan === 'basic') {
      return res.status(403).json({ error: 'plan_required', message: 'Los gastos están disponibles desde el plan Pro.' });
    }
    const expCats = b.expenseCategories !== undefined ? ops.cleanExpenseCategories(b.expenseCategories) : null;
    if (pm === null && dm === null && cur === null && tax === null && zones === null && expCats === null) throw new BadRequest('No hay cambios para guardar');
    const out = await inTx(async (c) => {
      const { rows: [t] } = await c.query('SELECT base_currency FROM tenants WHERE id = $1 FOR UPDATE', [tenantId]);
      if (cur && cur !== t.base_currency) {
        if (await baseCurrencyInUse(c, tenantId)) throw new BadRequest(BASE_CURRENCY_LOCKED_MSG);
        await c.query('UPDATE tenants SET base_currency = $1 WHERE id = $2', [cur, tenantId]);
      }
      const { rows: [s] } = await c.query(`
        INSERT INTO tenant_settings (tenant_id, payment_methods, delivery_methods, tax, zones, expense_categories)
        VALUES ($1, COALESCE($2::jsonb, '[]'::jsonb), COALESCE($3::jsonb, '{}'::jsonb), COALESCE($4::jsonb, '{}'::jsonb), COALESCE($5::jsonb, '[]'::jsonb), $6::jsonb)
        ON CONFLICT (tenant_id) DO UPDATE SET
          payment_methods  = COALESCE($2::jsonb, tenant_settings.payment_methods),
          delivery_methods = COALESCE($3::jsonb, tenant_settings.delivery_methods),
          tax              = COALESCE($4::jsonb, tenant_settings.tax),
          zones            = COALESCE($5::jsonb, tenant_settings.zones),
          expense_categories = COALESCE($6::jsonb, tenant_settings.expense_categories),
          updated_at = now()
        RETURNING payment_methods, delivery_methods, tax, zones, expense_categories`,
        [tenantId, pm === null ? null : JSON.stringify(pm), dm === null ? null : JSON.stringify(dm),
         tax === null ? null : JSON.stringify(tax), zones === null ? null : JSON.stringify(zones),
         expCats === null ? null : JSON.stringify(expCats)]);
      const inUse = await baseCurrencyInUse(c, tenantId);
      const { rows: [loc] } = await c.query('SELECT country, timezone FROM tenants WHERE id = $1', [tenantId]);
      return { baseCurrency: cur || t.base_currency, paymentMethods: s.payment_methods, deliveryMethods: s.delivery_methods,
        tax: mapTax(s.tax), zones: s.zones || [], ...locationOf(loc), canChangeBaseCurrency: !inUse, currencies: BASE_CURRENCIES,
        expenseCategories: Array.isArray(s.expense_categories) && s.expense_categories.length ? s.expense_categories : ops.DEFAULT_EXPENSE_CATEGORIES };
    });
    res.json(out);
  } catch (err) { sendApiError(res, err, 'Guardar ajustes'); }
});


// ══════════════════════════════════════════════════════════════
// API — Reports
// ══════════════════════════════════════════════════════════════

// Informes del negocio. Todo se calcula en SU zona horaria: "hoy" es hoy allí, no en UTC.
// period: hoy | 7dias | mes | año | personalizado (con from/to YYYY-MM-DD) · canal: todos | wa | ig
// tz (opcional): zona del navegador, solo si el negocio aún no tiene una guardada.
const MONTHS_ES = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
const DAYS_ES = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

// Buckets de los gráficos a partir de la fecha/hora local del negocio (y,m,d,h como números)
function reportBuckets(period, now, from, to) {
  const U = (y, m, d, h = 0) => new Date(Date.UTC(y, m - 1, d, h)); // fecha "local" tratada como UTC
  const key = (dt, kind) => {
    const p = n => String(n).padStart(2, '0');
    const base = dt.getUTCFullYear() + '-' + p(dt.getUTCMonth() + 1);
    if (kind === 'month') return base;
    if (kind === 'day') return base + '-' + p(dt.getUTCDate());
    return base + '-' + p(dt.getUTCDate()) + 'T' + p(dt.getUTCHours());
  };
  const out = [];
  if (period === 'hoy') {
    for (let i = 6; i >= 0; i--) {
      const dt = U(now.y, now.m, now.d, now.h - i);
      const hr = dt.getUTCHours();
      out.push({ keys: [key(dt, 'hour')], label: hr === 0 ? '12am' : hr < 12 ? hr + 'am' : hr === 12 ? '12pm' : (hr - 12) + 'pm' });
    }
    return { kind: 'hour', buckets: out };
  }
  if (period === '7dias') {
    for (let i = 6; i >= 0; i--) {
      const dt = U(now.y, now.m, now.d - i);
      out.push({ keys: [key(dt, 'day')], label: DAYS_ES[dt.getUTCDay()] });
    }
    return { kind: 'day', buckets: out };
  }
  if (period === 'mes') {
    const daysInMonth = new Date(Date.UTC(now.y, now.m, 0)).getUTCDate();
    const starts = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28].filter(d => d <= daysInMonth);
    starts.forEach((sd, i) => {
      const ed = i < starts.length - 1 ? starts[i + 1] - 1 : daysInMonth;
      const keys = [];
      for (let d = sd; d <= ed; d++) keys.push(key(U(now.y, now.m, d), 'day'));
      out.push({ keys, label: String(sd) });
    });
    return { kind: 'day', buckets: out };
  }
  if (period === 'personalizado') {
    const a = U(...from.split('-').map(Number)), b = U(...to.split('-').map(Number));
    const days = Math.round((b - a) / 86400000) + 1;
    if (days <= 31) {
      for (let i = 0; i < days; i++) {
        const dt = new Date(a.getTime() + i * 86400000);
        out.push({ keys: [key(dt, 'day')], label: dt.getUTCDate() + '/' + (dt.getUTCMonth() + 1) });
      }
      return { kind: 'day', buckets: out };
    }
    for (let dt = U(a.getUTCFullYear(), a.getUTCMonth() + 1, 1); dt <= b; dt = U(dt.getUTCFullYear(), dt.getUTCMonth() + 2, 1)) {
      out.push({ keys: [key(dt, 'month')], label: MONTHS_ES[dt.getUTCMonth()] + (dt.getUTCFullYear() !== now.y ? ' ' + String(dt.getUTCFullYear()).slice(2) : '') });
    }
    return { kind: 'month', buckets: out };
  }
  for (let m = 1; m <= 12; m++) out.push({ keys: [key(U(now.y, m, 1), 'month')], label: MONTHS_ES[m - 1] }); // año
  return { kind: 'month', buckets: out };
}

// Filtro de fecha SOBRE LA COLUMNA CRUDA (sin envolverla en funciones): así puede usar el índice (tenant_id, created_at). Equivale a
// pasar la columna a la hora local del negocio: [$3, $4) en la zona $2 (created_at de orders es timestamp en la zona de la sesión).
const tsIn = (col) => `${col} >= ($3::timestamp AT TIME ZONE $2) AND ($4::timestamp IS NULL OR ${col} < ($4::timestamp AT TIME ZONE $2))`;

// Rango de un informe en la zona del negocio (lo comparten /api/reports y /api/reports/*)
// period: hoy | 7dias | mes | año | personalizado (con from/to) · canal: todos | wa | ig
async function resolveReportRange(req, tenantId) {
  const period = String(req.query.period || 'hoy');
  const canal = ['wa', 'ig'].includes(req.query.canal) ? req.query.canal : 'todos';
  if (!['hoy', '7dias', 'mes', 'año', 'personalizado'].includes(period)) throw new BadRequest('Periodo inválido');
  let from = null, to = null;
  if (period === 'personalizado') {
    from = String(req.query.from || ''); to = String(req.query.to || '');
    if (!isRealDate(from) || !isRealDate(to)) throw new BadRequest('Fechas inválidas (formato YYYY-MM-DD)');
    if (from > to) throw new BadRequest('La fecha inicial debe ser anterior a la final');
    if ((Date.parse(to) - Date.parse(from)) / 86400000 > 366) throw new BadRequest('El rango máximo es de un año');
  }
  const tz = await resolveTenantTz(tenantId);
  const { rows: [nowRow] } = await pool.query("SELECT to_char(NOW() AT TIME ZONE $1, 'YYYY-MM-DD HH24') AS now_local", [tz]);
  const [ymd, hh] = nowRow.now_local.split(' ');
  const [y, m, d] = ymd.split('-').map(Number);
  const now = { y, m, d, h: Number(hh) };
  const startLocal = {
    hoy: ymd, '7dias': new Date(Date.UTC(y, m - 1, d - 6)).toISOString().slice(0, 10),
    mes: ymd.slice(0, 8) + '01', 'año': y + '-01-01', personalizado: from,
  }[period];
  const endExclusive = period === 'personalizado' ? new Date(Date.parse(to) + 86400000).toISOString().slice(0, 10) : null;
  return { period, canal, from, to, tz, ymd, now, startLocal, endExclusive };
}
const planRequired = (res) => res.status(403).json({ error: 'plan_required', message: 'Los informes están disponibles desde el plan Pro.' });

// Como mucho 2 informes a la vez por réplica: los demás esperan en cola (no es un error) y así los informes pesados no agotan el pool
// de conexiones ni dejan sin servicio al resto de la app. El hueco se traspasa directamente al primero de la cola.
const REPORT_MAX_CONCURRENT = 2;
let reportActive = 0;
const reportQueue = [];
async function reportSlot(req, res, next) {
  if (reportActive >= REPORT_MAX_CONCURRENT) await new Promise(r => reportQueue.push(r)); else reportActive++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = reportQueue.shift();
    if (n) n(); else reportActive--;
  };
  res.once('close', release);
  next();
}

app.get('/api/reports', requireAuth, reportSlot, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (req.tenant.plan === 'basic') {
    return res.status(403).json({ error: 'plan_required', message: 'Los informes están disponibles desde el plan Pro.' });
  }
  const tenantId = req.tenant.tenantId;
  try {
    const { period, canal, from, to, tz, ymd, now, startLocal, endExclusive } = await resolveReportRange(req, tenantId);

    // Fecha/hora local de cada fila: created_at se guarda en la zona de la sesión de la base
    const LOCAL = (col) => `((${col} AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE $2)`;
    const inPeriod = (col) => `${LOCAL(col)} >= $3::timestamp AND ($4::timestamp IS NULL OR ${LOCAL(col)} < $4::timestamp)`;
    const canalCond = `($5 = 'todos' OR o.platform = $5)`;
    const P = [tenantId, tz, startLocal, endExclusive, canal];
    const ENC = `lower(coalesce(o.delivery_method_label, '')) LIKE '%encomienda%'`;
    const DLV = `(NOT ${ENC} AND (lower(coalesce(o.delivery_method_label, '')) LIKE '%motorizado%' OR lower(coalesce(o.delivery_method_label, '')) LIKE '%delivery%'))`;
    // Solo pedidos de verdad: los presupuestos no cuentan, y los anulados salen de ventas e informes (se cuentan aparte)
    const W = `o.tenant_id = $1 AND o.kind = 'order' AND o.delivery_status <> 'cancelled' AND ${tsIn('o.created_at')} AND ${canalCond}`;
    // Los anulados se cuentan en la misma pasada del KPI (FILTER) y no en una consulta aparte
    const WALL = `o.tenant_id = $1 AND o.kind = 'order' AND ${tsIn('o.created_at')} AND ${canalCond}`;
    const OK = "o.delivery_status <> 'cancelled'";
    const OPEN = "('to_deliver', 'preparing', 'on_the_way')"; // sin entregar todavía
    const { kind, buckets } = reportBuckets(period, now, from, to);
    const bucketFmt = { hour: 'YYYY-MM-DD"T"HH24', day: 'YYYY-MM-DD', month: 'YYYY-MM' }[kind];

    // Cobros reales: pagos no anulados − reembolsos, cada uno en SU fecha (zona del negocio), en moneda base.
    // El saldo a favor no es dinero nuevo: queda fuera de ambos lados.
    const cobros = pool.query(`
      SELECT method, SUM(total)::float AS total FROM (
        SELECT p.method, COALESCE(SUM(p.amount_base), 0) AS total
        FROM payments p JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1 AND p.voided_at IS NULL AND p.method <> $6
          AND p.paid_at >= ($3::timestamp AT TIME ZONE $2) AND ($4::timestamp IS NULL OR p.paid_at < ($4::timestamp AT TIME ZONE $2))
          AND ${canalCond}
        GROUP BY p.method
        UNION ALL
        SELECT r.method, -COALESCE(SUM(r.amount_base), 0)
        FROM refunds r JOIN orders o ON o.id = r.order_id AND o.tenant_id = r.tenant_id
        WHERE r.tenant_id = $1 AND r.method <> $6
          AND r.created_at >= ($3::timestamp AT TIME ZONE $2) AND ($4::timestamp IS NULL OR r.created_at < ($4::timestamp AT TIME ZONE $2))
          AND ${canalCond}
        GROUP BY r.method
      ) x GROUP BY method ORDER BY total DESC, method`, [...P, CREDIT_METHOD]);
    const [kpi, pays, tops, encRows, series, cobrosRows] = await Promise.all([
      pool.query(`
        SELECT COALESCE(SUM(o.total_price - o.credited_total) FILTER (WHERE ${OK}), 0)::float AS ventas,
               COUNT(*) FILTER (WHERE ${OK})::int AS pedidos,
               COUNT(*) FILTER (WHERE NOT ${OK})::int AS cancelados,
               COUNT(*) FILTER (WHERE ${OK} AND o.delivery_status = 'delivered')::int AS entregados,
               COUNT(*) FILTER (WHERE ${OK} AND o.delivery_status IN ${OPEN})::int AS pendientes,
               COUNT(*) FILTER (WHERE ${OK} AND o.delivery_status = 'not_delivered')::int AS no_entregados,
               COUNT(*) FILTER (WHERE ${OK} AND ${DLV})::int AS delivery,
               COUNT(*) FILTER (WHERE ${OK} AND ${ENC})::int AS encomiendas,
               COUNT(*) FILTER (WHERE ${OK} AND ${ENC} AND o.delivery_status = 'delivered')::int AS enc_entregadas,
               COUNT(*) FILTER (WHERE ${OK} AND ${ENC} AND o.delivery_status IN ${OPEN})::int AS enc_transito,
               COALESCE(SUM(o.shipping) FILTER (WHERE ${OK} AND ${ENC}), 0)::float AS enc_ingresos,
               COALESCE(AVG(o.shipping) FILTER (WHERE ${OK} AND o.shipping > 0), 0)::float AS avg_shipping,
               COUNT(*) FILTER (WHERE ${OK} AND o.platform = 'wa')::int AS count_wa,
               COUNT(*) FILTER (WHERE ${OK} AND o.platform = 'ig')::int AS count_ig,
               -- clientes nuevos del periodo: misma consulta, una escalar más (en vez de una consulta aparte)
               (SELECT COUNT(*)::int FROM clients c WHERE c.tenant_id = $1 AND ${inPeriod('c.created_at')} AND ($5 = 'todos' OR c.channel = $5)) AS new_clients
        FROM orders o WHERE ${WALL}`, P),
      pool.query(`
        SELECT o.pay_method_label AS label, COUNT(*)::int AS n FROM orders o
        WHERE ${W} AND o.pay_method_label IS NOT NULL AND o.pay_method_label NOT IN ('', '—')
        GROUP BY o.pay_method_label ORDER BY n DESC, label`, P),
      // Top productos: artículos de los pedidos menos lo devuelto por artículos; un pedido sin artículos cuenta como 1
      // unidad de su resumen. Margen = (ventas − costo) / ventas solo sobre las líneas CON costo (antes del descuento del pedido).
      pool.query(`
        WITH rets AS (
          SELECT cni.order_item_id, SUM(cni.qty)::int AS ret
          FROM orders o
          JOIN credit_notes cn ON cn.order_id = o.id AND cn.tenant_id = o.tenant_id
          JOIN credit_note_items cni ON cni.credit_note_id = cn.id AND cni.tenant_id = cn.tenant_id
          WHERE ${W} AND o.credited_total > 0 AND cni.order_item_id IS NOT NULL
          GROUP BY cni.order_item_id)
        SELECT name, MIN(emoji) AS emoji, SUM(qty)::int AS qty, SUM(revenue)::float AS revenue,
               COALESCE(SUM(cost), 0)::float AS cost, COALESCE(SUM(rev_costed), 0)::float AS rev_costed FROM (
          SELECT COALESCE(oi.name, 'Producto') AS name, oi.emoji,
            GREATEST(oi.qty - COALESCE(r.ret, 0), 0) AS qty,
            COALESCE(oi.line_price, 0) * GREATEST(oi.qty - COALESCE(r.ret, 0), 0) / NULLIF(oi.qty, 0) AS revenue,
            CASE WHEN oi.unit_cost IS NOT NULL THEN oi.unit_cost * GREATEST(oi.qty - COALESCE(r.ret, 0), 0) END AS cost,
            CASE WHEN oi.unit_cost IS NOT NULL THEN COALESCE(oi.line_price, 0) * GREATEST(oi.qty - COALESCE(r.ret, 0), 0) / NULLIF(oi.qty, 0) END AS rev_costed
          FROM order_items oi JOIN orders o ON o.id = oi.order_id AND oi.tenant_id = o.tenant_id
          LEFT JOIN rets r ON r.order_item_id = oi.id
          WHERE ${W}
          UNION ALL
          -- Pedido sin artículos: 1 unidad de su resumen por su total neto de notas de crédito (fuera si queda en 0)
          SELECT COALESCE(o.product_summary, 'Producto'), NULL, 1, GREATEST(COALESCE(o.total_price, 0) - COALESCE(o.credited_total, 0), 0), NULL, NULL
          FROM orders o
          WHERE ${W} AND COALESCE(o.total_price, 0) - COALESCE(o.credited_total, 0) > 0
            AND NOT EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.tenant_id = o.tenant_id)
        ) x GROUP BY name HAVING SUM(qty) > 0 ORDER BY qty DESC, revenue DESC LIMIT 5`, P),
      pool.query(`
        SELECT COALESCE(o.tenant_order_number, o.order_number) AS num, o.client_name, o.address, o.delivery_status, o.shipping
        FROM orders o WHERE ${W} AND ${ENC}
        ORDER BY o.created_at DESC LIMIT 10`, P),
      pool.query(`
        SELECT to_char(${LOCAL('o.created_at')}, '${bucketFmt}') AS b, COALESCE(SUM(o.total_price - o.credited_total), 0)::float AS amount, COUNT(*)::int AS n
        FROM orders o WHERE ${W} GROUP BY b`, P),
      cobros,
    ]);

    const k = kpi.rows[0];
    const byBucket = new Map(series.rows.map(r => [r.b, r]));
    const bars = [], barsCount = [];
    for (const bk of buckets) {
      let amount = 0, n = 0;
      for (const key of bk.keys) { const r = byBucket.get(key); if (r) { amount += r.amount; n += r.n; } }
      bars.push(Math.round(amount * 100) / 100);
      barsCount.push(n);
    }
    const canalTotal = k.count_wa + k.count_ig;
    const money = v => Math.round((Number(v) || 0) * 100) / 100;

    res.json({
      timezone: tz,
      period, canal, from: startLocal, to: endExclusive ? to : ymd,
      ventas: money(k.ventas),
      cobrado: money(cobrosRows.rows.reduce((a, r) => a + r.total, 0)),
      cobrosPorMetodo: mergeMethodTotals(cobrosRows.rows).map(m => [m.method, money(m.total)]),
      pedidos: k.pedidos,
      entregados: k.entregados,
      pendientes: k.pendientes,
      noEntregados: k.no_entregados,
      cancelados: k.cancelados, // pedidos anulados creados en el periodo (no cuentan en ventas ni pedidos)
      delivery: k.delivery,
      encomiendas: k.encomiendas,
      encomiendasEntregadas: k.enc_entregadas,
      encomiendasEnTransito: k.enc_transito,
      encomiendasIngresos: money(k.enc_ingresos),
      avgShipping: money(k.avg_shipping),
      newClients: k.new_clients,
      canal: canalTotal > 0
        ? { wa: Math.round(k.count_wa / canalTotal * 100), ig: Math.round(k.count_ig / canalTotal * 100) }
        : { wa: 0, ig: 0 },
      paymentMethods: pays.rows.map(r => [r.label, r.n]),
      // [nombre, unidades, ventas, margen % (null si ninguna línea tiene costo)]
      topProducts: tops.rows.map(r => [(r.emoji || '📦') + ' ' + r.name, r.qty, '$' + (Number(r.revenue) || 0).toFixed(0),
        r.rev_costed > 0 ? Math.round((r.rev_costed - r.cost) / r.rev_costed * 100) : null]),
      encomiendaRows: encRows.rows.map(r => ({
        id: '#' + String(r.num).padStart(4, '0'), cliente: r.client_name || '—', destino: r.address || '—',
        estado: r.delivery_status === 'delivered' ? 'Entregado' : r.delivery_status === 'not_delivered' ? 'No entregado' : 'En tránsito',
        costo: r.shipping !== null && r.shipping !== undefined && Number(r.shipping) > 0 ? '$' + Number(r.shipping).toFixed(2) : '—',
      })),
      bars, barsCount, barLabels: buckets.map(b => b.label),
    });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json(badRequestBody(err));
    console.error('Informes:', err.message);
    res.status(500).json({ error: 'No se pudo calcular el informe' });
  }
});

// Utilidad del periodo (Pro y Business). Todo en moneda base. Pedidos de verdad (sin presupuestos ni anulados) creados en el periodo.
//  · vendido      = Σ (total − notas de crédito)                      (con envío e impuesto)
//  · cobrado      = pagos − reembolsos del periodo, cada uno en SU fecha (sin saldo a favor)
//  · devuelto     = Σ notas de crédito creadas en el periodo
//  · ventasItems  = ventas netas de artículos, SIN envío NI impuesto: por línea, precio × (unidades − devueltas) / unidades,
//                   con el descuento del pedido PRORRATEADO entre sus líneas (descuento tope = Σ líneas); una devolución por
//                   importe se descuenta primero del envío y el resto (sin impuesto) de las ventas de artículos.
//                   Un pedido antiguo sin artículos aporta total − envío − impuesto (todo «sin costo»).
//  · costo        = Σ unit_cost × (unidades − devueltas), solo líneas con foto de costo
//  · utilidadBruta = ventasItems − costo (una línea sin costo cuenta como costo 0: por eso ventasSinCosto avisa)
//  · gastos       = gastos no anulados con fecha en el periodo (no tienen canal: con un canal filtrado no se calculan)
//  · utilidadNeta = utilidadBruta − gastos
app.get('/api/reports/profit', requireAuth, reportSlot, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (req.tenant.plan === 'basic') return planRequired(res);
  const tenantId = req.tenant.tenantId;
  try {
    const { period, canal, to, tz, ymd, startLocal, endExclusive } = await resolveReportRange(req, tenantId);
    const LOCAL = (col) => `((${col} AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE $2)`;
    const inPeriod = (col) => `${LOCAL(col)} >= $3::timestamp AND ($4::timestamp IS NULL OR ${LOCAL(col)} < $4::timestamp)`;
    const canalCond = `($5 = 'todos' OR o.platform = $5)`;
    const P = [tenantId, tz, startLocal, endExclusive, canal];
    const W = `o.tenant_id = $1 AND o.kind = 'order' AND o.delivery_status <> 'cancelled' AND ${tsIn('o.created_at')} AND ${canalCond}`;
    const [prof, cobros, extra] = await Promise.all([
      pool.query(`
        WITH ord AS (
          SELECT o.id, o.total_price, o.credited_total, COALESCE(o.shipping, 0) AS shipping, COALESCE(o.discount, 0) AS discount, o.tax_rate, COALESCE(o.tax_amount, 0) AS tax_amount,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id AND oi.tenant_id = o.tenant_id) AS n_items,
            (SELECT COALESCE(SUM(oi.line_price), 0) FROM order_items oi WHERE oi.order_id = o.id AND oi.tenant_id = o.tenant_id) AS gross,
            (SELECT COALESCE(SUM(cni.amount), 0) FROM credit_note_items cni JOIN credit_notes cn ON cn.id = cni.credit_note_id AND cn.tenant_id = cni.tenant_id
              WHERE cn.order_id = o.id AND cn.tenant_id = o.tenant_id AND cni.order_item_id IS NULL) AS by_amount
          FROM orders o WHERE ${W}
        ), rets AS (
          SELECT cni.order_item_id, SUM(cni.qty) AS ret
          FROM ord
          JOIN credit_notes cn ON cn.order_id = ord.id AND cn.tenant_id = $1
          JOIN credit_note_items cni ON cni.credit_note_id = cn.id AND cni.tenant_id = $1
          WHERE ord.credited_total > 0 AND cni.order_item_id IS NOT NULL
          GROUP BY cni.order_item_id
        ), line AS (
          SELECT ord.id AS order_id, oi.unit_cost, oi.qty, oi.line_price,
            GREATEST(oi.qty - COALESCE(rets.ret, 0), 0) AS kept,
            CASE WHEN ord.gross > 0 THEN GREATEST(0, ord.gross - LEAST(ord.discount, ord.gross)) / ord.gross ELSE 1 END AS factor
          FROM ord JOIN order_items oi ON oi.order_id = ord.id AND oi.tenant_id = $1
          LEFT JOIN rets ON rets.order_item_id = oi.id
        ), po AS (
          SELECT order_id,
            SUM(line_price * factor * kept / NULLIF(qty, 0)) AS net,
            SUM(unit_cost * kept) FILTER (WHERE unit_cost IS NOT NULL) AS cost,
            SUM(line_price * factor * kept / NULLIF(qty, 0)) FILTER (WHERE unit_cost IS NULL) AS nocost,
            SUM(line_price * factor * kept / NULLIF(qty, 0)) FILTER (WHERE unit_cost IS NOT NULL) AS withcost
          FROM line GROUP BY order_id
        ), calc AS (
          SELECT ord.total_price - ord.credited_total AS vendido,
            CASE WHEN ord.n_items = 0 THEN GREATEST(0, ord.total_price - ord.credited_total - ord.shipping - ord.tax_amount) ELSE 0 END AS orphan,
            COALESCE(po.net, 0) AS net, COALESCE(po.cost, 0) AS cost, COALESCE(po.nocost, 0) AS nocost, COALESCE(po.withcost, 0) AS withcost,
            LEAST(COALESCE(po.net, 0), GREATEST(0, ord.by_amount - ord.shipping) / (1 + ord.tax_rate / 100)) AS red
          FROM ord LEFT JOIN po ON po.order_id = ord.id
        )
        SELECT COALESCE(SUM(vendido), 0)::float AS vendido, COUNT(*)::int AS pedidos,
          COALESCE(SUM(net - red + orphan), 0)::float AS ventas_items,
          COALESCE(SUM(cost), 0)::float AS costo,
          COALESCE(SUM(CASE WHEN net > 0 THEN nocost * (net - red) / net ELSE 0 END + orphan), 0)::float AS sin_costo,
          COALESCE(SUM(CASE WHEN net > 0 THEN withcost * (net - red) / net ELSE 0 END), 0)::float AS con_costo
        FROM calc`, P),
      pool.query(`
        SELECT COALESCE(SUM(t), 0)::float AS total FROM (
          SELECT COALESCE(SUM(p.amount_base), 0) AS t FROM payments p JOIN orders o ON o.id = p.order_id AND o.tenant_id = p.tenant_id
          WHERE p.tenant_id = $1 AND p.voided_at IS NULL AND p.method <> $6 AND ${tsIn('p.paid_at')} AND ${canalCond}
          UNION ALL
          SELECT -COALESCE(SUM(r.amount_base), 0) FROM refunds r JOIN orders o ON o.id = r.order_id AND o.tenant_id = r.tenant_id
          WHERE r.tenant_id = $1 AND r.method <> $6 AND ${tsIn('r.created_at')} AND ${canalCond}
        ) x`, [...P, CREDIT_METHOD]),
      // Devoluciones, gastos y moneda base en UNA consulta (tres escalares con los mismos parámetros)
      pool.query(`
        SELECT
          (SELECT COALESCE(SUM(cn.amount_base), 0)::float FROM credit_notes cn JOIN orders o ON o.id = cn.order_id AND o.tenant_id = cn.tenant_id
            WHERE cn.tenant_id = $1 AND ${tsIn('cn.created_at')} AND ${canalCond}) AS dev_total,
          (SELECT COUNT(*)::int FROM credit_notes cn JOIN orders o ON o.id = cn.order_id AND o.tenant_id = cn.tenant_id
            WHERE cn.tenant_id = $1 AND ${tsIn('cn.created_at')} AND ${canalCond}) AS dev_n,
          (SELECT COALESCE(SUM(amount_base), 0)::float FROM expenses
            WHERE tenant_id = $1 AND voided_at IS NULL AND spent_on >= $3::date AND ($4::date IS NULL OR spent_on < $4::date)) AS exp_total,
          (SELECT COUNT(*)::int FROM expenses
            WHERE tenant_id = $1 AND voided_at IS NULL AND spent_on >= $3::date AND ($4::date IS NULL OR spent_on < $4::date)) AS exp_n,
          (SELECT base_currency FROM tenants WHERE id = $1) AS base_currency`, P),
    ]);
    const dev = { rows: [{ total: extra.rows[0].dev_total, n: extra.rows[0].dev_n }] };
    const exp = { rows: [{ total: extra.rows[0].exp_total, n: extra.rows[0].exp_n }] };
    const base = { rows: [{ base_currency: extra.rows[0].base_currency }] };
    const k = prof.rows[0];
    const r2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
    const ventasItems = r2(k.ventas_items), costo = r2(k.costo), bruta = r2(ventasItems - costo);
    const conCosto = r2(k.con_costo);
    const gastosAplican = canal === 'todos';
    const gastos = gastosAplican ? r2(exp.rows[0].total) : null;
    res.json({
      timezone: tz, period, canal, from: startLocal, to: endExclusive ? to : ymd, baseCurrency: base.rows[0] ? base.rows[0].base_currency : 'USD',
      pedidos: k.pedidos, vendido: r2(k.vendido), cobrado: r2(cobros.rows[0].total),
      devuelto: r2(dev.rows[0].total), devueltoCount: dev.rows[0].n,
      ventasItems, costo, utilidadBruta: bruta,
      margenBruto: conCosto > 0 ? Math.round((conCosto - costo) / conCosto * 1000) / 10 : null, // % sobre las ventas CON costo
      ventasSinCosto: r2(k.sin_costo), ventasConCosto: conCosto,
      gastos, gastosCount: gastosAplican ? exp.rows[0].n : null, gastosAplican,
      utilidadNeta: gastosAplican ? r2(bruta - gastos) : null,
    });
  } catch (err) {
    if (err instanceof BadRequest) return res.status(400).json(badRequestBody(err));
    console.error('Utilidad:', err.message);
    res.status(500).json({ error: 'No se pudo calcular la utilidad' });
  }
});

// Por cobrar con antigüedad (Pro y Business): saldo de pedidos no anulados, en tramos de 0–7, 8–30, 31–60 y más de 60
// días desde la creación del pedido, y los clientes que más deben (hasta 50: nombre, total y pedido más antiguo).
const RECEIVABLES_LIMIT = 50;
app.get('/api/reports/receivables', requireAuth, reportSlot, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  if (req.tenant.plan === 'basic') return planRequired(res);
  const tenantId = req.tenant.tenantId;
  try {
    const tz = await resolveTenantTz(tenantId); // la antigüedad se cuenta en días del negocio (sin ubicación: 400 location_required)
    const OPEN = `o.tenant_id = $1 AND o.kind = 'order' AND o.delivery_status <> 'cancelled' AND o.total_price - o.credited_total - o.amount_paid > 0`;
    const TODAY = "(NOW() AT TIME ZONE $2)::date";
    const DAY_OF = (col) => `((${col} AT TIME ZONE current_setting('TimeZone')) AT TIME ZONE $2)::date`;
    const [buckets, debtors, base] = await Promise.all([
      pool.query(`
        SELECT CASE WHEN age <= 7 THEN 0 WHEN age <= 30 THEN 1 WHEN age <= 60 THEN 2 ELSE 3 END AS b,
               SUM(bal)::float AS total, COUNT(*)::int AS n
        FROM (SELECT o.total_price - o.credited_total - o.amount_paid AS bal,
                     (${TODAY} - ${DAY_OF('o.created_at')})::int AS age
              FROM orders o WHERE ${OPEN}) x GROUP BY b`, [tenantId, tz]),
      pool.query(`
        SELECT COALESCE(o.client_id::text, 'n:' || lower(COALESCE(o.client_name, ''))) AS k,
               (array_agg(o.client_id ORDER BY o.created_at))[1] AS client_id,
               (array_agg(o.client_name ORDER BY o.created_at DESC))[1] AS name,
               SUM(o.total_price - o.credited_total - o.amount_paid)::float AS total, COUNT(*)::int AS n,
               MIN(o.created_at) AS oldest_at,
               (array_agg(COALESCE(o.tenant_order_number, o.order_number) ORDER BY o.created_at))[1] AS oldest_num,
               (${TODAY} - ${DAY_OF('MIN(o.created_at)')})::int AS oldest_age
        FROM orders o WHERE ${OPEN}
        GROUP BY 1 ORDER BY total DESC, name LIMIT ${RECEIVABLES_LIMIT + 1}`, [tenantId, tz]),
      pool.query('SELECT base_currency FROM tenants WHERE id = $1', [tenantId]),
    ]);
    const defs = [['0-7', '0–7 días'], ['8-30', '8–30 días'], ['31-60', '31–60 días'], ['60+', 'Más de 60 días']];
    const byB = new Map(buckets.rows.map(r => [r.b, r]));
    const out = defs.map(([key, label], i) => ({ key, label, total: money2(byB.get(i) ? byB.get(i).total : 0), count: byB.get(i) ? byB.get(i).n : 0 }));
    const bucketOf = (age) => age <= 7 ? '0-7' : age <= 30 ? '8-30' : age <= 60 ? '31-60' : '60+';
    res.json({
      baseCurrency: base.rows[0] ? base.rows[0].base_currency : 'USD',
      total: money2(out.reduce((a, b) => a + b.total, 0)), count: out.reduce((a, b) => a + b.count, 0), buckets: out,
      debtors: debtors.rows.slice(0, RECEIVABLES_LIMIT).map(r => ({
        clientId: r.client_id, name: r.name || 'Sin nombre', total: money2(r.total), orders: r.n,
        oldestOrder: '#' + String(r.oldest_num).padStart(4, '0'), oldestAt: r.oldest_at, oldestDays: r.oldest_age, bucket: bucketOf(r.oldest_age),
      })),
      truncated: debtors.rows.length > RECEIVABLES_LIMIT, limit: RECEIVABLES_LIMIT,
    });
  } catch (err) { sendApiError(res, err, 'Por cobrar'); }
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
    return res.status(400).json({ error: 'Falta el nombre del cliente' });
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
  } catch (err) { sendApiError(res, err, 'Eliminar cliente'); }
});

// ══════════════════════════════════════════════════════════════
// API — Catálogo
// ══════════════════════════════════════════════════════════════

app.get('/api/catalog', requireAuth, async (req, res) => {
  try {
    const catalog = await dbGetCatalog(req.tenant.tenantId);
    // El vendedor no ve costos ni márgenes
    res.json(req.user.role === 'seller' ? catalog.map(({ cost, ...rest }) => rest) : catalog);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/catalog', requireAuth, async (req, res) => {
  if (!req.body || !req.body.name) {
    return res.status(400).json({ error: 'Falta el nombre del producto' });
  }
  try {
    const product = await dbUpsertProduct(req.tenant.tenantId, { ...req.body, id: undefined });
    res.json(product);
  } catch (err) { sendApiError(res, err, 'Crear producto'); }
});

app.patch('/api/catalog/:id', requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Producto no encontrado' });
  try {
    const product = await dbUpsertProduct(req.tenant.tenantId, { ...req.body, id: req.params.id });
    if (!product) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(product);
  } catch (err) { sendApiError(res, err, 'Editar producto'); }
});

// ── Existencias (Fase 4A) ─────────────────────────────────────
// Niveles por producto y variante (pueden ser negativos). Sin productId: todos los del negocio (límite 5000).
const STOCK_LEVELS_LIMIT = 5000;
app.get('/api/stock', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const tenantId = req.tenant.tenantId;
  try {
    if (req.query.productId === undefined || req.query.productId === '') {
      const { rows } = await pool.query(`
        SELECT l.product_id, l.variant_key, l.qty FROM stock_levels l
        JOIN catalog_products p ON p.id = l.product_id AND p.tenant_id = l.tenant_id
        WHERE l.tenant_id = $1 ORDER BY l.product_id, l.variant_key LIMIT ${STOCK_LEVELS_LIMIT + 1}`, [tenantId]);
      return res.json({
        levels: rows.slice(0, STOCK_LEVELS_LIMIT).map(r => ({ productId: r.product_id, variantKey: r.variant_key, qty: r.qty })),
        truncated: rows.length > STOCK_LEVELS_LIMIT,
      });
    }
    if (!UUID_RE.test(String(req.query.productId))) return res.status(404).json({ error: 'Producto no encontrado' });
    const { rows: [p] } = await pool.query('SELECT * FROM catalog_products WHERE id = $1 AND tenant_id = $2', [req.query.productId, tenantId]);
    if (!p) return res.status(404).json({ error: 'Producto no encontrado' });
    const { rows } = await pool.query('SELECT variant_key, qty FROM stock_levels WHERE product_id = $1 AND tenant_id = $2 ORDER BY variant_key LIMIT 500', [p.id, tenantId]);
    res.json({
      productId: p.id, trackStock: !!p.track_stock,
      ...(req.user.role === 'seller' ? {} : { cost: p.cost === null ? null : Number(p.cost) }), // el vendedor no ve costos
      variants: ops.productVariants(p), levels: rows.map(r => ({ productId: p.id, variantKey: r.variant_key, qty: r.qty })),
    });
  } catch (err) { sendApiError(res, err, 'Existencias'); }
});

app.post('/api/stock/adjust', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try { res.json(await inTx(c => ops.adjustStockTx(c, req.tenant.tenantId, req.body, req.user))); }
  catch (err) { sendApiError(res, err, 'Ajustar existencias'); }
});

// Historial de movimientos (el más reciente primero). productId y variantKey opcionales; limit ≤ 500 (por defecto 100)
app.get('/api/stock/movements', requireAuth, async (req, res) => {
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  const tenantId = req.tenant.tenantId;
  try {
    let productId = null;
    if (req.query.productId !== undefined && req.query.productId !== '') {
      productId = String(req.query.productId);
      if (!UUID_RE.test(productId)) return res.status(404).json({ error: 'Producto no encontrado' });
    }
    const vk = req.query.variantKey === undefined ? null : ops.normVariantKey(req.query.variantKey);
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100));
    const { rows } = await pool.query(`
      SELECT m.*, COALESCE(o.tenant_order_number, o.order_number) AS order_num, o.kind AS order_kind
      FROM stock_movements m LEFT JOIN orders o ON o.id = m.order_id AND o.tenant_id = m.tenant_id
      WHERE m.tenant_id = $1 AND ($2::uuid IS NULL OR m.product_id = $2) AND ($3::text IS NULL OR m.variant_key = $3)
      ORDER BY m.created_at DESC, m.id LIMIT ${limit + 1}`, [tenantId, productId, vk]);
    res.json({ movements: await ops.attachByName(pool, tenantId, rows.slice(0, limit).map(ops.mapMovementRow), ops.BY_CREATED), truncated: rows.length > limit, limit });
  } catch (err) { sendApiError(res, err, 'Movimientos de existencias'); }
});

app.delete('/api/catalog/:id', requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'Producto no encontrado' });
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
  const tenantId = String(req.tenant.tenantId);
  if (!dbReady) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    // Solo se entregan archivos que pertenecen a un mensaje de este negocio
    const { rows } = await pool.query(
      'SELECT 1 FROM messages WHERE media_id = $1 AND tenant_id = $2 LIMIT 1',
      [mediaId, tenantId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Archivo no encontrado o expirado' });
    let cached = mediaCache[mediaId];
    if (!cached || cached.tenantId !== tenantId) {
      const creds = await getTenantCredentials(tenantId);
      cached = await downloadMediaFromMeta(mediaId, creds.whatsapp_token, tenantId);
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
    if (req.tenant?.isDemo === false) return next();
    if (req.tenant?.isDemo !== true) return res.status(503).json({ error: 'Servicio no disponible, intenta en un momento' });
    const b = req.body || {};
    const tenantId = req.tenant.tenantId;
    if (b.igId !== undefined && (typeof b.igId !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(b.igId))) {
      return res.status(400).json({ error: 'igId inválido' });
    }
    const viaIg = kind === 'ig' || (kind === 'ticket' && !!b.igId);
    const platform = viaIg ? 'ig' : 'wa';
    const convoKey = viaIg ? (b.igId ? `ig_${b.igId}` : null) : b.waId;
    if (!convoKey) return res.status(400).json({ error: 'Falta el destinatario' });
    const text = kind === 'ticket' ? (b.caption || '🧾 Resguardo de compra')
               : kind === 'media'  ? (b.caption || '📎 Archivo adjunto')
               : b.text;
    if (!text) return res.status(400).json({ error: 'Falta el texto' });
    try {
      await dbGetOrCreateConvo(convoKey, null, tenantId, platform, viaIg ? b.igId : null);
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

    const sentMessage = {
      id:   await sendWaText(creds, waId, text),
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

    mediaCache[mediaId] = { buffer: file.buffer, mimeType: file.mimetype, size: file.size, tenantId: String(req.tenant.tenantId) };

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

// Instagram solo acepta imágenes por URL pública: el ticket se publica en un enlace aleatorio
// que caduca a los 15 minutos, el tiempo justo para que Meta lo descargue.
const TICKET_LINK_TTL_MS = 15 * 60 * 1000;
const publicTicketImages = new Map(); // token → { buffer, expires }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of publicTicketImages) if (now > v.expires) publicTicketImages.delete(k);
}, 60 * 1000).unref();

function publishTicketImage(buffer) {
  // Tope de memoria: si hubiera demasiados, se descartan los más antiguos
  while (publicTicketImages.size >= 500) publicTicketImages.delete(publicTicketImages.keys().next().value);
  const token = crypto.randomBytes(32).toString('hex');
  publicTicketImages.set(token, { buffer, expires: Date.now() + TICKET_LINK_TTL_MS });
  return `${APP_URL.replace(/\/$/, '')}/api/ticket-image/${token}`;
}

app.get('/api/ticket-image/:token', (req, res) => {
  const item = /^[0-9a-f]{64}$/.test(req.params.token) ? publicTicketImages.get(req.params.token) : null;
  if (!item || Date.now() > item.expires) return res.status(404).end();
  res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  res.send(item.buffer);
});

async function sendIgImageByUrl(creds, igId, url) {
  const response = await axios.post(
    `https://graph.instagram.com/${GRAPH_API_VERSION}/me/messages`,
    { recipient: { id: igId }, message: { attachment: { type: 'image', payload: { url } } } },
    { headers: { Authorization: `Bearer ${creds.instagram_access_token}`, 'Content-Type': 'application/json' } }
  );
  return response.data.message_id || 'ig_out_' + Date.now();
}

// Ticket por Instagram: imagen (por enlace temporal) y, si hay, el texto aparte (IG no admite pie de foto)
async function sendTicketInstagram(req, res) {
  const { igId, ticketHtml, caption, orderType } = req.body;
  const tenantId = req.tenant.tenantId;
  try {
    const creds = await getTenantCredentials(tenantId);
    if (!creds.instagram_access_token) return res.status(500).json({ error: 'Instagram no configurado' });

    const imageBuffer = await renderTicketImage(ticketHtml);
    const imageId = await sendIgImageByUrl(creds, igId, publishTicketImage(imageBuffer));
    const convoKey = `ig_${igId}`;
    await dbGetOrCreateConvo(convoKey, null, tenantId, 'ig', igId);

    const mediaId = 'igtkt_' + crypto.randomUUID();
    mediaCache[mediaId] = { buffer: imageBuffer, mimeType: 'image/png', size: imageBuffer.length, tenantId: String(tenantId) };
    const sentMessage = {
      id: imageId, role: 'out', type: 'image', mediaId, mimeType: 'image/png',
      caption: caption || '', mediaUrl: `/api/media/${mediaId}`, orderType: orderType || null,
      time: new Date().toISOString(),
    };
    await dbSaveMessage(sentMessage, convoKey, tenantId);
    broadcastToTenant(tenantId, { type: 'message_sent', waId: convoKey, platform: 'ig', message: sentMessage });

    if (caption) {
      try {
        const textMessage = { id: await sendIgText(creds, igId, caption), role: 'out', type: 'text', text: caption, time: new Date().toISOString() };
        await dbSaveMessage(textMessage, convoKey, tenantId);
      } catch (err) {
        console.error('Ticket IG: imagen enviada, texto no:', err.response?.data || err.message);
      }
    }
    console.log(`🧾 Ticket (${orderType || 'sin tipo'}) enviado por Instagram a ${igId}`);
    res.json({ success: true, message: sentMessage });
  } catch (err) {
    console.error('Error enviando ticket por Instagram:', err.response?.data || err.message);
    res.status(500).json({ error: 'Error al enviar ticket por Instagram', details: err.response?.data || err.message });
  }
}

app.post('/api/send-ticket', requireAuth, simulateIfDemo('ticket'), async (req, res) => {
  const { waId, igId, ticketHtml, caption, orderType } = req.body;
  if (!ticketHtml) return res.status(400).json({ error: 'Falta ticketHtml' });
  if (igId !== undefined) {
    if (typeof igId !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(igId)) return res.status(400).json({ error: 'igId inválido' });
    return sendTicketInstagram(req, res);
  }
  // Un id de Instagram nunca debe salir por WhatsApp
  if (!waId || String(waId).startsWith('ig_')) return res.status(400).json({ error: 'Falta waId (o igId para Instagram)' });

  try {
    const creds = await getTenantCredentials(req.tenant.tenantId);
    if (!creds.whatsapp_phone_number_id || !creds.whatsapp_token) {
      return res.status(500).json({ error: 'WhatsApp no configurado' });
    }

    const imageBuffer = await renderTicketImage(ticketHtml);
    const mediaId     = await uploadMediaToMeta(imageBuffer, 'image/png', `ticket_${Date.now()}.png`, creds.whatsapp_phone_number_id, creds.whatsapp_token);
    const result      = await sendMediaMessage(waId, mediaId, 'image', caption||'', null, creds.whatsapp_phone_number_id, creds.whatsapp_token);

    mediaCache[mediaId] = { buffer: imageBuffer, mimeType:'image/png', size: imageBuffer.length, tenantId: String(req.tenant.tenantId) };

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

    const messageId = await sendIgText(creds, igId, text);
    const convoKey = `ig_${igId}`;
    await dbGetOrCreateConvo(convoKey, igId, req.tenant.tenantId, 'ig', igId);
    const sentMessage = {
      id:   messageId,
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
  if ((req.method === 'GET' || req.method === 'HEAD') && /\.[a-z0-9]+$/i.test(p) && !PUBLIC_STATIC.test(p)) return res.status(404).end();
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
  res.setHeader('Referrer-Policy', 'no-referrer');
  const token = req.query.token;
  if (!token) return res.type('html').send(APP_BOOTSTRAP);

  let decoded;
  try { decoded = jwt.verify(token, JWT_SECRET); }
  catch { return res.type('html').send(APP_LOGOUT); }
  if (!decoded.tenantId) return res.type('html').send(APP_LOGOUT);

  if (!dbReady) return res.status(503).send('Servicio no disponible, intenta en un momento');
  // Mismas comprobaciones que la API (cuenta, usuario activo, token_version): un usuario desactivado no recibe la app
  const sess = await resolveSession(decoded);
  if (sess.fail) {
    if (sess.fail.status === 500) return res.status(503).send('Servicio no disponible, intenta en un momento');
    if (sess.expired) return res.type('html').send(buildExpiredPage(sess.tenantName));
    return res.type('html').send(APP_LOGOUT);
  }
  const tenant = { is_demo: sess.tenant.isDemo, expires_at: sess.tenant.expiresAt, business_name: sess.tenant.businessName, plan: sess.tenant.plan };
  const teamUser = { id: sess.user.id, name: sess.user.name, role: sess.user.role, mustChange: sess.user.must_change_password,
    overLimitSince: sess.user.role === 'owner' && sess.tenant.overLimitSince ? new Date(sess.tenant.overLimitSince).toISOString() : null };

  let html;
  try { html = fs.readFileSync(SPA_FILE, 'utf8'); }
  catch { return res.status(500).send('Error cargando la app'); }

  // El plan va en la página: el menú sale correcto desde el primer instante, sin esperar al perfil
  const plan = ['basic', 'pro', 'business'].includes(tenant.plan) ? tenant.plan : 'basic';
  let inject = `<script>(function(){var u=new URL(location.href);if(u.searchParams.has('token')){try{localStorage.setItem('central_jwt',u.searchParams.get('token'))}catch(e){}u.searchParams.delete('token');history.replaceState(null,'',u.pathname+(u.search||''))}})();window.__TENANT_PLAN__=${JSON.stringify(plan)};window.__TEAM_USER__=${JSON.stringify(teamUser).replace(/</g, () => String.fromCharCode(92) + 'u003c')};</script>`;
  if (tenant?.is_demo) {
    // Las demos no reciben las conversaciones de ejemplo originales escritas en la app
    html = html.replace(/const convos = \{\r?\n[\s\S]*?\r?\n\};\r?\n/, 'const convos = {};\n')
               .replace(/Zapatilla Runner/g, 'Tenis Urbano')
               .replace(/(<div class="convo-list" id="convoList">)[\s\S]*?(\r?\n\s*<\/div>\r?\n\s*<\/div>\r?\n\r?\n\s*<!-- CENTER: chat -->)/, '$1$2')
               .replace(/(id="chatName">)[^<]*/, '$1')
               .replace(/(id="chatAvatar"[^>]*>)[^<]*/, '$1')
               .replace(/(id="simCliente" value=")[^"]*/, '$1Cliente de ejemplo');
  }
  if (tenant?.is_demo) {
    // Va al principio del <head>: corre antes que cualquier script de la app
    const tid = JSON.stringify(String(decoded.tenantId).replace(/[^0-9a-f-]/gi, ''));
    const shim = `<script>(function(){var P='central_demo_'+${tid}+'__',K={central_jwt:1,central_auth:1,central_tenant:1,central_lang:1};var S=Storage.prototype,g=S.getItem,s=S.setItem,r=S.removeItem;function k(key){key=String(key);return K[key]?key:P+key}S.getItem=function(a){return g.call(this,k(a))};S.setItem=function(a,b){return s.call(this,k(a),b)};S.removeItem=function(a){return r.call(this,k(a))};var kk=S.key,ld=Object.getOwnPropertyDescriptor(S,'length');function own(st){var a=[],n=ld.get.call(st);for(var i=0;i<n;i++){var x=kk.call(st,i);if(x&&x.indexOf(P)===0)a.push(x.slice(P.length));else if(K[x])a.push(x)}return a}S.key=function(i){return own(this)[i]===undefined?null:own(this)[i]};Object.defineProperty(S,'length',{configurable:true,get:function(){return own(this).length}});S.clear=function(){var n=ld.get.call(this);for(var i=n-1;i>=0;i--){var x=kk.call(this,i);if(x&&x.indexOf(P)===0)r.call(this,x)}};})();</script>`;
    html = /<meta charset[^>]*>/i.test(html)
      ? html.replace(/<meta charset[^>]*>/i, (m) => m + shim)
      : html.replace(/<head>/i, (m) => m + shim);
  }
  if (tenant?.is_demo && tenant.expires_at) {
    const daysLeft = Math.max(0, Math.ceil((new Date(tenant.expires_at) - new Date()) / 86400000));
    inject += `<script>window.__DEMO_MODE__=true;window.__DEMO_DAYS_LEFT__=${daysLeft};window.__DEMO_EXPIRES__=${JSON.stringify(new Date(tenant.expires_at).toISOString())};</script>`;
  }
  html = html.replace('</head>', inject + '\n</head>');

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Referrer-Policy', 'no-referrer');
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
        await markTeamOverLimit(tenantId);
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
      const { rows: downgraded } = await pool.query(
        'UPDATE tenants SET plan=$1, billing_status=$2, stripe_subscription_id=$3 WHERE stripe_subscription_id=$4 RETURNING id',
        ['basic', 'cancelled', null, sub.id]
      );
      for (const t of downgraded) await markTeamOverLimit(t.id); // el dueño tiene 3 días para elegir a quién mantener
      console.log(`⚠️  Stripe: suscripción ${sub.id} cancelada — tenant bajado a basic`);
    }
  } catch (err) {
    console.error('Error procesando evento Stripe:', err.message);
  }

  res.json({ received: true });
});

app.post('/api/billing/create-checkout', requireAuth, demoBilling('checkout'), async (req, res) => {
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

app.get('/api/billing/status', requireAuth, demoBilling('status'), async (req, res) => {
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

app.post('/api/billing/cancel', requireAuth, demoBilling('info'), async (req, res) => {
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

app.post('/api/billing/portal', requireAuth, demoBilling('info'), async (req, res) => {
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
      pool.query(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE active) activos, COUNT(*) FILTER (WHERE NOT active) suspendidos FROM tenants WHERE is_demo IS NOT TRUE`),
      pool.query(`SELECT plan, COUNT(*) count FROM tenants WHERE is_demo IS NOT TRUE GROUP BY plan`),
      pool.query(`SELECT COUNT(*) count FROM tenants WHERE is_demo IS NOT TRUE AND created_at >= NOW() - INTERVAL '7 days'`),
      pool.query(`SELECT COUNT(*) count FROM conversations c JOIN tenants t ON t.id = c.tenant_id WHERE t.is_demo IS NOT TRUE`),
      pool.query(`SELECT COUNT(*) count FROM messages m JOIN tenants t ON t.id = m.tenant_id WHERE t.is_demo IS NOT TRUE`),
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
    const conditions = ['is_demo IS NOT TRUE'];
    const params     = [];
    if (search) { params.push(`%${search}%`); conditions.push(`(business_name ILIKE $${params.length} OR email ILIKE $${params.length})`); }
    if (plan)   { params.push(plan);   conditions.push(`plan = $${params.length}`); }
    if (status === 'active')    conditions.push(`active = true`);
    if (status === 'suspended') conditions.push(`active = false`);
    const where = 'WHERE ' + conditions.join(' AND ');

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
    if (!UUID_RE.test(String(req.params.tenantId))) return res.status(404).json({ error: 'Tenant no encontrado' });
    await pool.query('UPDATE tenants SET plan = $1 WHERE id = $2', [plan, req.params.tenantId]);
    await markTeamOverLimit(req.params.tenantId); // si baja de plan con usuarios de más: plazo de 3 días para que el dueño elija
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
  for (const [key, raw] of Object.entries(req.body || {})) {
    if (!allowed.includes(key)) continue;
    let val = raw;
    if (key === 'country') continue; // el país (y con él la zona horaria) se aplica abajo, con sus reglas
    if (key === 'email') {
      val = normEmail(raw);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val)) return res.status(400).json({ error: 'Correo electrónico inválido' });
    }
    sets.push(`${key} = $${i++}`);
    values.push(val);
  }
  const newCountry = req.body && req.body.country !== undefined ? req.body.country : undefined;
  if (sets.length === 0 && newCountry === undefined) return res.status(400).json({ error: 'No hay campos válidos para actualizar' });
  if (!UUID_RE.test(String(req.params.tenantId))) return res.status(404).json({ error: 'Tenant no encontrado' });
  values.push(req.params.tenantId);
  const txc = await pool.connect();
  try {
    await txc.query('BEGIN');
    if (newCountry !== undefined && !(await applyTenantLocation(txc, req.params.tenantId, { country: newCountry }))) {
      await txc.query('ROLLBACK'); return res.status(404).json({ error: 'Tenant no encontrado' });
    }
    const { rows } = sets.length
      ? await txc.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i} RETURNING id, business_name, full_name, email, country, timezone, whatsapp_number`, values)
      : await txc.query('SELECT id, business_name, full_name, email, country, timezone, whatsapp_number FROM tenants WHERE id = $1', [req.params.tenantId]);
    await txc.query('COMMIT');
    if (!rows[0]) return res.status(404).json({ error: 'Tenant no encontrado' });
    res.json({ success: true, tenant: rows[0] });
  } catch (err) {
    await txc.query('ROLLBACK').catch(() => {});
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err.code === '23505') return res.status(409).json({ error: 'Ese correo ya está en uso por otra cuenta' });
    console.error('Editar negocio (admin):', err);
    res.status(500).json({ error: 'No se pudo guardar el negocio. Inténtalo de nuevo.' });
  } finally {
    txc.release();
  }
});

app.post('/api/admin/tenants/:tenantId/reset-password', requireAdmin, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  }
  if (pwTooLong(newPassword)) return res.status(400).json({ error: PW_TOO_LONG_MSG });
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
const { seedDemoTenant, seedDemoTeam, wipeDemoData } = require('./demo-seed');
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.param('tenantId', (req, res, next, id) => {
  if (req.path.startsWith('/api/admin/demos/') && !UUID_RE.test(id)) return res.status(404).json({ error: 'Demo no encontrada' });
  next();
});

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
  const countryIn = String(b.country || '').trim() || null;
  const countryCanon = ops.canonCountry(countryIn);
  // La zona sale del país; una demo sin país (o «Otro») usa Venezuela / America/Caracas para tener siempre una zona
  const country = countryIn ? (countryCanon || countryIn) : 'Venezuela';
  const demoTz = ops.defaultTimezoneFor(countryCanon || (countryIn ? null : 'Venezuela')) || 'America/Caracas';
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
  let tenant, teamUsers;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      INSERT INTO tenants (business_name, full_name, email, password_hash, plan, country, is_demo, demo_days, expires_at, timezone)
      VALUES ($1,$2,$3,$4,'business',$5,true,$6, NOW() + make_interval(hours => $6 * 24), $7)
      RETURNING id, email, business_name, expires_at
    `, [businessName, ownerName || null, email, hash, country, days, demoTz]);
    tenant = rows[0];
    await seedDemoTenant(client, tenant.id, { city });
    teamUsers = await seedDemoTeam(client, tenant.id);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    if (err.code === '23505') return res.status(409).json({ error: 'Ese correo ya pertenece a otro usuario de CENTRAL' });
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
  res.json({ success: true, tenantId: tenant.id, email, password, expiresAt: tenant.expires_at, emailSent, emailError, teamUsers });
});

app.post('/api/admin/demos/:tenantId/extend', requireAdmin, requireDemoKey, async (req, res) => {
  const days = Math.min(30, Math.max(1, parseInt(req.body?.days, 10) || 7));
  try {
    const { rows } = await pool.query(`
      UPDATE tenants SET expires_at = GREATEST(expires_at, NOW()) + make_interval(hours => $2 * 24)
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
      `UPDATE tenants SET expires_at = NOW() - INTERVAL '1 second' WHERE id = $1 AND is_demo = true RETURNING id`,
      [req.params.tenantId]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Demo no encontrada' });
    closeTenantSockets(req.params.tenantId);
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
    // Los usuarios inventados (Encargado y Vendedor) también reciben clave nueva; los que creó el prospecto no se tocan
    const tc = await pool.connect();
    let teamUsers = [];
    try { await tc.query('BEGIN'); teamUsers = await seedDemoTeam(tc, req.params.tenantId); await tc.query('COMMIT'); }
    catch (e) { await tc.query('ROLLBACK').catch(() => {}); console.error('[DEMO] Claves del equipo:', e.message); }
    finally { tc.release(); }
    for (const u of teamUsers) closeUserSockets(req.params.tenantId, u.id);
    const t = rows[0];
    let emailSent = false, emailError = null;
    if (process.env.RESEND_API_KEY) {
      try {
        await sendDemoEmail({ to: t.email, ownerName: t.full_name, businessName: t.business_name, password, expiresAt: t.expires_at });
        emailSent = true;
      } catch (err) { emailError = err.message; }
    }
    res.json({ success: true, email: t.email, password, emailSent, emailError, teamUsers });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Vuelve a dejar la demo con los datos de ejemplo iniciales y en plan Business
app.post('/api/admin/demos/:tenantId/reset-data', requireAdmin, requireDemoKey, async (req, res) => {
  const client = await pool.connect().catch(() => null);
  if (!client) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM tenants WHERE id = $1 AND is_demo = true FOR UPDATE', [req.params.tenantId]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Demo no encontrada' }); }
    const { rows: cityRows } = await client.query('SELECT city FROM clients WHERE tenant_id = $1 AND city IS NOT NULL LIMIT 1', [req.params.tenantId]);
    await wipeDemoData(client, req.params.tenantId);
    await seedDemoTenant(client, req.params.tenantId, { city: cityRows[0]?.city || undefined });
    const teamUsers = await seedDemoTeam(client, req.params.tenantId);
    await client.query("UPDATE tenants SET plan = 'business', team_over_limit_since = NULL WHERE id = $1 AND is_demo = true", [req.params.tenantId]);
    await client.query('COMMIT');
    broadcastToTenant(req.params.tenantId, { type: 'demo_reset' });
    closeTenantSockets(req.params.tenantId); // los usuarios del equipo se volvieron a crear: sus sesiones anteriores ya no valen
    res.json({ success: true, teamUsers });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[DEMO] Error reiniciando datos:', err.message);
    res.status(500).json({ error: 'No se pudieron reiniciar los datos' });
  } finally {
    client.release();
  }
});

// Convierte una demo en cuenta real: borra todos los datos de ejemplo, quita la
// caducidad y la deja en el plan Basic (el cliente decide después si sube de plan)
app.post('/api/admin/demos/:tenantId/convert', requireAdmin, async (req, res) => {
  const client = await pool.connect().catch(() => null);
  if (!client) return res.status(503).json({ error: 'Base de datos no disponible' });
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id FROM tenants WHERE id = $1 AND is_demo = true FOR UPDATE', [req.params.tenantId]);
    if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Demo no encontrada' }); }
    await wipeDemoData(client, req.params.tenantId);
    await client.query(
      `UPDATE tenants SET is_demo = false, expires_at = NULL, plan = 'basic' WHERE id = $1 AND is_demo = true`,
      [req.params.tenantId]
    );
    await client.query('COMMIT');
    closeTenantSockets(req.params.tenantId);
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ══════════════════════════════════════════════════════════════
// ARRANQUE
// ══════════════════════════════════════════════════════════════
// Índices grandes: se construyen DESPUÉS de empezar a escuchar (CONCURRENTLY puede tardar con tablas grandes
// y no debe retrasar el arranque), fuera de transacción y con un advisory lock para que dos réplicas no
// lo hagan a la vez. Un índice inválido (construcción interrumpida) se borra y se rehace, salvo que otra
// sesión lo esté construyendo en ese momento.
const INDEX_LOCK_KEY = 72616101;
const BACKGROUND_INDEXES = [
  // order_items por pedido: JOIN de la lista de pedidos, ediciones, informes y el ON DELETE CASCADE de orders
  { name: 'order_items_order_idx', table: 'order_items', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS order_items_order_idx ON order_items (order_id)' },
  // Fase 3: unicidad del número de presupuesto por negocio
  { name: 'orders_tenant_quote_number_uniq', table: 'orders', sql: 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS orders_tenant_quote_number_uniq ON orders (tenant_id, quote_number) WHERE quote_number IS NOT NULL' },
  // Fase 4A: informes, utilidad y por cobrar filtran pedidos por (negocio, fecha de creación)
  { name: 'orders_tenant_created_idx', table: 'orders', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_tenant_created_idx ON orders (tenant_id, created_at)' },
  // Relleno de pagos en cada arranque (pagos.js): hace barata la búsqueda de pedidos 'ok' sin pago. Parcial:
  // solo contiene pedidos pendientes de convertir (casi siempre ninguno).
  { name: 'orders_legacy_paid_id_idx', table: 'orders', sql: "CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_legacy_paid_id_idx ON orders (id) WHERE pay_status = 'ok' AND amount_paid = 0 AND total_price > 0" },
  // Fase 4B: lista de pedidos paginada por cursor (tenant, created_at DESC, id) y sus filtros por estado y cliente
  { name: 'orders_tenant_created_desc_idx', table: 'orders', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_tenant_created_desc_idx ON orders (tenant_id, created_at DESC, id DESC)' },
  { name: 'orders_tenant_client_idx', table: 'orders', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS orders_tenant_client_idx ON orders (tenant_id, client_id) WHERE client_id IS NOT NULL' },
  // Fase 4B: chats paginados (por último mensaje) y mensajes de un chat hacia atrás
  { name: 'conversations_tenant_last_idx', table: 'conversations', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS conversations_tenant_last_idx ON conversations (tenant_id, last_message_at DESC NULLS LAST, wa_id)' },
  { name: 'messages_tenant_wa_time_idx', table: 'messages', sql: 'CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_tenant_wa_time_idx ON messages (tenant_id, wa_id, time DESC, id)' },
  // Fase 4B: las FK «quién hizo qué» (ON DELETE SET NULL) necesitan índice para que borrar un usuario no recorra la tabla; parciales (casi vacíos)
  ...team.USER_FK_COLUMNS.map(([table, col]) => ({ name: `${table}_${col}_idx`, table,
    sql: `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${table}_${col}_idx ON ${table} (${col}) WHERE ${col} IS NOT NULL` })),
];
async function ensureIndexes() {
  if (!dbReady) return;
  const client = await pool.connect();
  let locked = false;
  try {
    locked = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [INDEX_LOCK_KEY])).rows[0].ok;
    if (!locked) return; // otra réplica se encarga
    for (const ix of BACKGROUND_INDEXES) {
      try {
        // Solo el índice de ESTE nombre en el esquema public Y sobre la tabla esperada (un índice homónimo de otra
        // tabla —p. ej. de otra app en la misma base— ni se toca ni se borra)
        const { rows } = await client.query(
          `SELECT i.indisvalid, i.indrelid = to_regclass($2) AS mine
           FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relname = $1 AND n.nspname = 'public'`, [ix.name, 'public.' + ix.table]);
        if (rows[0] && !rows[0].mine) {
          console.error(`❌ Ya existe un índice ${ix.name} que NO es de la tabla ${ix.table}: no se crea (cambia el nombre del índice de CENTRAL)`);
          continue;
        }
        if (rows[0] && rows[0].indisvalid) continue;
        if (rows[0]) {
          const busy = await client.query(
            `SELECT 1 FROM pg_stat_progress_create_index p JOIN pg_class c ON c.oid = p.index_relid
             JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = $1 AND n.nspname = 'public'`, [ix.name]);
          if (busy.rows.length) continue; // alguien lo está construyendo (p. ej. a mano)
          await client.query(`DROP INDEX CONCURRENTLY IF EXISTS public.${ix.name}`);
        }
        const t0 = Date.now();
        await client.query(ix.sql);
        console.log(`✅ Índice ${ix.name} listo (${Date.now() - t0} ms)`);
      } catch (err) {
        console.error(`⚠️  Índice ${ix.name} (la app funciona sin él, más lenta):`, err.message);
      }
    }
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [INDEX_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

initDB().then(() => {
  server.listen(PORT, () => {
    console.log(`🚀 CENTRAL Backend v5.0 escuchando en puerto ${PORT}`);
    ensureIndexes().catch(err => console.error('⚠️  ensureIndexes:', err.message));
    validateOrdersKindCheck(pool).catch(err => console.error('⚠️  validateOrdersKindCheck:', err.message));
    teamLimitSweep();
    setInterval(teamLimitSweep, 60 * 60000).unref();
    team.validateTeamFks(pool).catch(err => console.error('⚠️  validateTeamFks:', err.message));
    if (backfillAfterListen) {
      runPaymentsBackfill(pool).catch(() => {});
      setTimeout(() => runPaymentsBackfill(pool).catch(() => {}), 10 * 60000).unref();
    }
  });
});
