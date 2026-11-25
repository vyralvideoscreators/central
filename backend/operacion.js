// Fase 4A — dinero y existencias: gastos, cierre de caja, costo y existencias por variante.
// Esquema (solo DDL, idempotente; SQL documentado en migrations/2026-11-27-gastos-existencias.sql) y la lógica
// transaccional que comparten server.js y demo-seed.js.
//
// Reglas (no romper):
//  · El dinero y las existencias no se editan, se registran: gastos y ajustes solo se insertan (o se anulan, con motivo).
//  · Todo en la moneda base del negocio. Todo dentro de la transacción de quien llama.
//  · ORDEN DE BLOQUEO (siempre): pedido → tenant → cliente → existencias (stock_levels, ordenadas por producto y variante).
//    Las operaciones de dinero toman la fila del tenant FOR SHARE (lockTenantForCash) y el cierre/reapertura de caja
//    FOR UPDATE: así «cerrar» y «cobrar» a la vez se serializan y quien llega segundo ve el cierre.
'use strict';

const { hasColumn, hasRelation, ensureOwnIndex, normalizeMethodName, methodKey, isCreditMethod, CREDIT_METHOD } = require('./pagos');

class BadRequest extends Error {}

const OPS_DDL_LOCK_KEY = 72616105;
const DEFAULT_TIMEZONE = 'America/Caracas';
const MAX_MONEY = 99999999.99;
const MAX_STOCK_QTY = 1000000;
const MAX_VARIANTS_PER_PRODUCT = 400;
const DEFAULT_EXPENSE_CATEGORIES = ['Compras de mercancía', 'Envíos', 'Alquiler', 'Servicios', 'Publicidad', 'Sueldos', 'Otros'];
const MAX_EXPENSE_CATEGORIES = 30;
const STOCK_REASONS = ['sale', 'cancel', 'return', 'edit', 'adjust_in', 'adjust_out', 'count'];

// ── Utilidades ────────────────────────────────────────────────
const centsOf = (n) => Math.round(Number(n || 0) * 100);
const money2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const isRealDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(Date.parse(s)).toISOString().slice(0, 10) === s;
const payNum = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) ? Number(v) : NaN;
const cleanText = (v, max, label, required) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s) { if (required) throw new BadRequest(label + ' obligatorio'); return null; }
  if (s.length > max) throw new BadRequest(`${label} demasiado largo (máx. ${max} caracteres)`);
  return s;
};
const stripAccents = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
function validTz(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
const tzOf = (t) => (t && validTz(t.timezone)) ? t.timezone : DEFAULT_TIMEZONE;
const dayLabel = (day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`; // 2026-11-27 → 27/11
const shiftDay = (d, k) => new Date(Date.parse(d) + k * 86400000).toISOString().slice(0, 10);

// ── Variantes (talla × color) ─────────────────────────────────
// Clave estable: «talla|color» en minúsculas, sin acentos y sin espacios sobrantes; '' si el artículo no tiene variante.
const normPart = (s) => stripAccents(String(s ?? '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()).slice(0, 60);
function buildVariantKey(size, color) {
  const a = normPart(size), b = normPart(color);
  return a || b ? a + '|' + b : '';
}
// Normaliza una clave ya armada («S|Coral» → «s|coral»); acepta '' y claves de una sola parte
function normVariantKey(k) {
  if (k === undefined || k === null || k === '') return '';
  const [a, b] = String(k).slice(0, 130).split('|');
  return buildVariantKey(a, b);
}
// Variantes que ofrece un producto del catálogo: tallas × colores (colores = [{name,hex}] o textos)
function productVariants(p) {
  const sizes = (Array.isArray(p.sizes) ? p.sizes : []).map(s => String(s ?? '').trim()).filter(Boolean);
  const colors = (Array.isArray(p.colors) ? p.colors : []).map(c => String(c && typeof c === 'object' ? c.name : c ?? '').trim()).filter(Boolean);
  const out = [];
  if (sizes.length && colors.length) { for (const s of sizes) for (const c of colors) out.push({ key: buildVariantKey(s, c), size: s, color: c }); }
  else if (sizes.length) for (const s of sizes) out.push({ key: buildVariantKey(s, ''), size: s, color: '' });
  else if (colors.length) for (const c of colors) out.push({ key: buildVariantKey('', c), size: '', color: c });
  else out.push({ key: '', size: '', color: '' });
  const seen = new Set();
  return out.filter(v => !seen.has(v.key) && seen.add(v.key)).slice(0, MAX_VARIANTS_PER_PRODUCT);
}

// ── Esquema ───────────────────────────────────────────────────
// Columnas propias de CENTRAL en cada tabla nueva: si ya existe una tabla con ese nombre SIN ellas, es de otra
// aplicación (la base se comparte con Kisses, que usa el prefijo kp_). Nunca se escribe en ella ni se sigue arrancando.
const OPS_TABLE_COLS = {
  expenses:        ['tenant_id', 'spent_on', 'amount_base', 'category'],
  cash_closings:   ['tenant_id', 'day', 'expected', 'counted'],
  stock_levels:    ['tenant_id', 'product_id', 'variant_key', 'qty'],
  stock_movements: ['tenant_id', 'product_id', 'variant_key', 'delta'],
};
async function assertOpsTablesAreOurs(db) {
  for (const [table, cols] of Object.entries(OPS_TABLE_COLS)) {
    if (!(await hasRelation(db, table))) continue;
    for (const col of cols) {
      if (!(await hasColumn(db, table, col))) {
        console.error(`❌ La tabla ${table} ya existe en la base pero NO es de CENTRAL (le falta la columna ${col}). ` +
          'Se detiene el arranque para no escribir en datos ajenos: renombra esa tabla o cambia el nombre en operacion.js.');
        process.exit(1);
      }
    }
  }
}

// Solo DDL, en una transacción corta con advisory lock y lock_timeout. Antes de cada ALTER/CREATE se comprueba si
// ya existe: en un arranque normal no se ejecuta ningún DDL. Devuelve true si el esquema quedó completo.
async function ensureStockExpensesSchema(pool) {
  await assertOpsTablesAreOurs(pool); // antes de tocar nada
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [OPS_DDL_LOCK_KEY]);
    await client.query(`SET LOCAL lock_timeout = '5s'`);
    // Columnas nulas o con DEFAULT constante: solo tocan el catálogo (instantáneo). ADD COLUMN IF NOT EXISTS pide el
    // bloqueo aunque exista: solo se ejecuta si falta.
    for (const [table, col, ddl] of [
      ['catalog_products', 'cost',               'NUMERIC(12,2) CHECK (cost IS NULL OR cost >= 0)'],
      ['catalog_products', 'track_stock',        'BOOLEAN NOT NULL DEFAULT false'],
      ['order_items',      'unit_cost',          'NUMERIC(12,2)'],
      ['order_items',      'variant_key',        'TEXT'],
      ['tenant_settings',  'expense_categories', 'JSONB'],
    ]) if (!(await hasColumn(client, table, col))) await client.query(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);

    if (!(await hasRelation(client, 'expenses'))) {
      await client.query(`
        CREATE TABLE expenses (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          spent_on      DATE NOT NULL,
          amount        NUMERIC(12,2) NOT NULL CHECK (amount > 0),
          currency      TEXT NOT NULL,
          exchange_rate NUMERIC(18,6) NOT NULL DEFAULT 1 CHECK (exchange_rate > 0),
          amount_base   NUMERIC(12,2) NOT NULL CHECK (amount_base > 0),
          category      TEXT NOT NULL,
          method        TEXT NOT NULL,
          note          TEXT,
          created_by    TEXT NOT NULL DEFAULT 'owner',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          voided_at     TIMESTAMPTZ,
          void_reason   TEXT
        )`);
    }
    if (!(await hasRelation(client, 'cash_closings'))) {
      await client.query(`
        CREATE TABLE cash_closings (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          day           DATE NOT NULL,
          expected      JSONB NOT NULL,
          counted       JSONB NOT NULL,
          difference    JSONB NOT NULL,
          note          TEXT,
          closed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          closed_by     TEXT NOT NULL DEFAULT 'owner',
          reopened_at   TIMESTAMPTZ,
          reopen_reason TEXT
        )`);
    }
    if (!(await hasRelation(client, 'stock_levels'))) {
      await client.query(`
        CREATE TABLE stock_levels (
          tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          product_id  UUID NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
          variant_key TEXT NOT NULL DEFAULT '',
          qty         INTEGER NOT NULL DEFAULT 0,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (tenant_id, product_id, variant_key)
        )`);
    }
    if (!(await hasRelation(client, 'stock_movements'))) {
      await client.query(`
        CREATE TABLE stock_movements (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
          product_id  UUID NOT NULL REFERENCES catalog_products(id) ON DELETE CASCADE,
          variant_key TEXT NOT NULL DEFAULT '',
          delta       INTEGER NOT NULL CHECK (delta <> 0),
          qty_after   INTEGER NOT NULL,
          reason      TEXT NOT NULL CHECK (reason IN ('sale','cancel','return','edit','adjust_in','adjust_out','count')),
          order_id    UUID REFERENCES orders(id) ON DELETE SET NULL,
          note        TEXT,
          created_by  TEXT NOT NULL DEFAULT 'owner',
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`);
    }
    // Tablas NUEVAS (vacías): sus índices se crean aquí, no en BACKGROUND_INDEXES
    for (const [name, table, sql] of [
      ['expenses_tenant_spent_idx',      'expenses',        'CREATE INDEX expenses_tenant_spent_idx ON expenses (tenant_id, spent_on)'],
      ['cash_closings_open_day_uniq',    'cash_closings',   'CREATE UNIQUE INDEX cash_closings_open_day_uniq ON cash_closings (tenant_id, day) WHERE reopened_at IS NULL'],
      ['cash_closings_tenant_day_idx',   'cash_closings',   'CREATE INDEX cash_closings_tenant_day_idx ON cash_closings (tenant_id, day)'],
      ['stock_levels_product_idx',       'stock_levels',    'CREATE INDEX stock_levels_product_idx ON stock_levels (product_id)'],
      ['stock_movements_product_idx',    'stock_movements', 'CREATE INDEX stock_movements_product_idx ON stock_movements (tenant_id, product_id, created_at DESC)'],
      ['stock_movements_order_idx',      'stock_movements', 'CREATE INDEX stock_movements_order_idx ON stock_movements (order_id) WHERE order_id IS NOT NULL'],
    ]) await ensureOwnIndex(client, name, table, sql);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('⚠️  Migración de gastos y existencias:', err.message);
  } finally {
    client.release();
  }
  try {
    const cols = [['catalog_products', 'cost'], ['catalog_products', 'track_stock'], ['order_items', 'unit_cost'],
      ['order_items', 'variant_key'], ['tenant_settings', 'expense_categories']];
    for (const [t, c] of cols) if (!(await hasColumn(pool, t, c))) return false;
    for (const r of Object.keys(OPS_TABLE_COLS)) if (!(await hasRelation(pool, r))) return false;
    await assertOpsTablesAreOurs(pool);
    return true;
  } catch (err) {
    console.error('❌ Comprobación del esquema de gastos y existencias:', err.message);
    return false;
  }
}

// ── Categorías de gastos (tenant_settings.expense_categories; null = lista por defecto) ──
function cleanExpenseCategories(v) {
  if (!Array.isArray(v)) throw new BadRequest('Las categorías de gastos deben ser una lista');
  if (v.length > MAX_EXPENSE_CATEGORIES) throw new BadRequest(`Máximo ${MAX_EXPENSE_CATEGORIES} categorías de gastos`);
  const seen = new Set();
  const out = v.map(c => {
    if (typeof c !== 'string') throw new BadRequest('Cada categoría es un texto');
    const name = c.replace(/\s+/g, ' ').trim();
    if (!name || name.length > 60) throw new BadRequest('Categoría de gasto: el nombre es obligatorio (máx. 60 caracteres)');
    const k = stripAccents(name).toLowerCase();
    if (seen.has(k)) throw new BadRequest(`Categoría repetida: "${name}"`);
    seen.add(k);
    return name;
  });
  if (!out.length) throw new BadRequest('Deja al menos una categoría de gasto');
  return out;
}
async function getExpenseCategories(db, tenantId) {
  const { rows } = await db.query('SELECT expense_categories FROM tenant_settings WHERE tenant_id = $1', [tenantId]);
  const v = rows[0] && rows[0].expense_categories;
  return Array.isArray(v) && v.length ? v : DEFAULT_EXPENSE_CATEGORIES.slice();
}

// ── Caja: bloqueo y cierre por día ─────────────────────────────
// Toma la fila del tenant. Operaciones de dinero: SHARE (varias a la vez); cerrar/reabrir caja: UPDATE (esperan a todas).
// Devuelve { timezone, base_currency }.
async function lockTenantForCash(db, tenantId, mode = 'SHARE') {
  const { rows } = await db.query(`SELECT timezone, base_currency FROM tenants WHERE id = $1 FOR ${mode === 'UPDATE' ? 'UPDATE' : 'SHARE'}`, [tenantId]);
  if (!rows[0]) throw new Error('Tenant no encontrado');
  return rows[0];
}
// Día del negocio (YYYY-MM-DD) de un instante (null = ahora)
async function businessDay(db, tz, instant = null) {
  const { rows: [r] } = await db.query(`SELECT to_char(COALESCE($1::timestamptz, now()) AT TIME ZONE $2, 'YYYY-MM-DD') AS d`, [instant, tz]);
  return r.d;
}
// Falla (400) si alguno de los días está cerrado. Hay que llamarla DENTRO de la transacción de la operación.
async function assertCashOpen(db, tenantId, { instants = [], days = [] } = {}) {
  const t = await lockTenantForCash(db, tenantId, 'SHARE');
  const tz = tzOf(t);
  const all = new Set(days);
  for (const i of instants) all.add(await businessDay(db, tz, i));
  if (!all.size) return t;
  const { rows } = await db.query(
    'SELECT day FROM cash_closings WHERE tenant_id = $1 AND reopened_at IS NULL AND day = ANY($2::date[]) ORDER BY day LIMIT 1', [tenantId, [...all]]);
  if (rows[0]) throw new BadRequest(`La caja del ${dayLabel(rows[0].day)} está cerrada. Reábrela en Pagos para registrar o anular movimientos de ese día.`);
  return t;
}

// Esperado por método del día: cobros − reembolsos − gastos (pagos no anulados; el saldo a favor no es dinero nuevo).
// Devuelve [{ method, cobrado, reembolsado, gastos, esperado }] ordenado por método canónico.
async function computeCashExpected(db, tenantId, day, tz) {
  const RANGE = (col) => `${col} >= ($2::date::timestamp AT TIME ZONE $3) AND ${col} < (($2::date + 1)::timestamp AT TIME ZONE $3)`;
  const [pay, ref, exp] = await Promise.all([
    db.query(`SELECT method, COALESCE(SUM(amount_base), 0) AS t FROM payments
              WHERE tenant_id = $1 AND voided_at IS NULL AND method <> $4 AND ${RANGE('paid_at')} GROUP BY method`, [tenantId, day, tz, CREDIT_METHOD]),
    db.query(`SELECT method, COALESCE(SUM(amount_base), 0) AS t FROM refunds
              WHERE tenant_id = $1 AND method <> $4 AND ${RANGE('created_at')} GROUP BY method`, [tenantId, day, tz, CREDIT_METHOD]),
    db.query(`SELECT method, COALESCE(SUM(amount_base), 0) AS t FROM expenses
              WHERE tenant_id = $1 AND voided_at IS NULL AND spent_on = $2::date GROUP BY method`, [tenantId, day]),
  ]);
  const by = new Map();
  const add = (rows, field) => {
    for (const r of rows) {
      const k = methodKey(r.method);
      if (!by.has(k)) by.set(k, { method: normalizeMethodName(r.method), cobrado: 0, reembolsado: 0, gastos: 0 });
      by.get(k)[field] += centsOf(r.t);
    }
  };
  add(pay.rows, 'cobrado'); add(ref.rows, 'reembolsado'); add(exp.rows, 'gastos');
  return [...by.values()].map(m => ({
    method: m.method, cobrado: m.cobrado / 100, reembolsado: m.reembolsado / 100, gastos: m.gastos / 100,
    esperado: (m.cobrado - m.reembolsado - m.gastos) / 100,
  })).sort((a, b) => a.method.localeCompare(b.method));
}

function mapClosing(r) {
  const exp = r.expected || {}, cnt = r.counted || {}, dif = r.difference || {};
  const methods = [...new Set([...Object.keys(exp), ...Object.keys(cnt)])].sort((a, b) => a.localeCompare(b));
  const lines = methods.map(m => ({ method: m, expected: Number(exp[m] || 0), counted: Number(cnt[m] || 0), difference: Number(dif[m] || 0) }));
  return {
    id: r.id, day: r.day, status: r.reopened_at ? 'reopened' : 'closed', note: r.note,
    closedAt: r.closed_at, closedBy: r.closed_by, reopenedAt: r.reopened_at, reopenReason: r.reopen_reason,
    lines,
    totalExpected: money2(lines.reduce((a, l) => a + l.expected, 0)),
    totalCounted: money2(lines.reduce((a, l) => a + l.counted, 0)),
    totalDifference: money2(lines.reduce((a, l) => a + l.difference, 0)),
  };
}

// Estado de un día: esperado por método + cierre vigente + historial de cierres (con sus reaperturas)
async function getCashDay(db, tenantId, day) {
  if (!isRealDate(day)) throw new BadRequest('Fecha inválida (formato AAAA-MM-DD)');
  const { rows: [t] } = await db.query('SELECT timezone, base_currency FROM tenants WHERE id = $1', [tenantId]);
  const tz = tzOf(t);
  const [expected, hist, today] = await Promise.all([
    computeCashExpected(db, tenantId, day, tz),
    db.query('SELECT * FROM cash_closings WHERE tenant_id = $1 AND day = $2::date ORDER BY closed_at DESC LIMIT 50', [tenantId, day]),
    businessDay(db, tz),
  ]);
  const history = hist.rows.map(mapClosing);
  const current = history.find(h => h.status === 'closed') || null;
  return {
    day, today, timezone: tz, baseCurrency: t.base_currency || 'USD',
    status: current ? 'closed' : 'open', isFuture: day > today,
    expected, expectedTotal: money2(expected.reduce((a, m) => a + m.esperado, 0)),
    closing: current, history,
  };
}

// Cierra la caja de un día. counted = { método: importe }, uno por cada método con esperado ≠ 0.
async function closeCashDay(db, tenantId, day, body, createdBy = 'owner') {
  if (!isRealDate(day)) throw new BadRequest('Fecha inválida (formato AAAA-MM-DD)');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Datos del cierre inválidos');
  const note = cleanText(body.note, 300, 'Nota', false);
  const t = await lockTenantForCash(db, tenantId, 'UPDATE'); // espera a que terminen las operaciones de dinero en curso
  const tz = tzOf(t);
  const today = await businessDay(db, tz);
  if (day > today) throw new BadRequest('No se puede cerrar un día futuro');
  const { rows: [open] } = await db.query('SELECT 1 FROM cash_closings WHERE tenant_id = $1 AND day = $2::date AND reopened_at IS NULL', [tenantId, day]);
  if (open) throw new BadRequest(`La caja del ${dayLabel(day)} ya está cerrada`);
  const raw = body.counted;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequest('Indica lo contado por método de pago');
  const entries = Object.entries(raw);
  if (entries.length > 30) throw new BadRequest('Demasiados métodos de pago');
  const countedC = new Map(); // clave canónica → { name, cents }
  for (const [name, v] of entries) {
    const m = normalizeMethodName(cleanText(name, 60, 'Método', true));
    if (isCreditMethod(m)) throw new BadRequest('El saldo a favor no entra en la caja');
    const n = payNum(v);
    if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) throw new BadRequest(`Importe contado inválido en «${m}»`);
    const k = methodKey(m);
    const cur = countedC.get(k) || { name: m, cents: 0 };
    cur.cents += centsOf(n);
    countedC.set(k, cur);
  }
  const expected = await computeCashExpected(db, tenantId, day, tz);
  const expObj = {}, cntObj = {}, difObj = {};
  for (const e of expected) {
    if (centsOf(e.esperado) !== 0 && !countedC.has(methodKey(e.method))) throw new BadRequest(`Falta contar «${e.method}»`);
    expObj[e.method] = e.esperado;
  }
  const names = new Map(expected.map(e => [methodKey(e.method), e.method]));
  for (const [k, c] of countedC) {
    const name = names.get(k) || c.name;
    cntObj[name] = c.cents / 100;
  }
  for (const m of new Set([...Object.keys(expObj), ...Object.keys(cntObj)])) {
    expObj[m] = expObj[m] || 0;
    cntObj[m] = cntObj[m] || 0;
    difObj[m] = (centsOf(cntObj[m]) - centsOf(expObj[m])) / 100;
  }
  const { rows: [row] } = await db.query(`
    INSERT INTO cash_closings (tenant_id, day, expected, counted, difference, note, closed_by)
    VALUES ($1, $2::date, $3, $4, $5, $6, $7) RETURNING *`,
    [tenantId, day, JSON.stringify(expObj), JSON.stringify(cntObj), JSON.stringify(difObj), note, createdBy]);
  return mapClosing(row);
}

async function reopenCashDay(db, tenantId, day, body) {
  if (!isRealDate(day)) throw new BadRequest('Fecha inválida (formato AAAA-MM-DD)');
  const reason = cleanText(body && body.reason, 200, 'Motivo', true);
  await lockTenantForCash(db, tenantId, 'UPDATE');
  const { rows } = await db.query(
    'UPDATE cash_closings SET reopened_at = now(), reopen_reason = $3 WHERE tenant_id = $1 AND day = $2::date AND reopened_at IS NULL RETURNING *',
    [tenantId, day, reason]);
  if (!rows[0]) throw new BadRequest(`La caja del ${dayLabel(day)} no está cerrada`);
  return mapClosing(rows[0]);
}

// ── Gastos ────────────────────────────────────────────────────
const PAY_CURRENCY_RE = /^[A-Z]{3,5}$/;
function mapExpenseRow(r) {
  return {
    id: r.id, spentOn: r.spent_on, amount: Number(r.amount), currency: r.currency, exchangeRate: Number(r.exchange_rate),
    amountBase: Number(r.amount_base), category: r.category, method: normalizeMethodName(r.method), note: r.note,
    createdAt: r.created_at, createdBy: r.created_by, voided: !!r.voided_at, voidedAt: r.voided_at, voidReason: r.void_reason,
  };
}

async function addExpenseTx(db, tenantId, body, createdBy = 'owner') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Datos del gasto inválidos');
  const t0 = await lockTenantForCash(db, tenantId, 'SHARE');
  const tz = tzOf(t0), base = t0.base_currency || 'USD';
  const today = await businessDay(db, tz);
  let spentOn = today;
  if (body.spentOn !== undefined && body.spentOn !== null && body.spentOn !== '') {
    spentOn = String(body.spentOn).trim();
    if (!isRealDate(spentOn) || Number(spentOn.slice(0, 4)) < 2000) throw new BadRequest('Fecha del gasto inválida (formato AAAA-MM-DD)');
    if (spentOn > today) throw new BadRequest('La fecha del gasto no puede ser futura');
  }
  const amount = payNum(body.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_MONEY) throw new BadRequest('Monto inválido');
  const amountR = Math.round(amount * 100) / 100;
  if (amountR <= 0) throw new BadRequest('Monto inválido');
  const currency = body.currency === undefined || body.currency === null || body.currency === '' ? base : String(body.currency).trim().toUpperCase();
  if (!PAY_CURRENCY_RE.test(currency)) throw new BadRequest('Moneda inválida');
  let rate = 1, amountBaseC = centsOf(amountR);
  if (currency !== base) {
    rate = payNum(body.exchangeRate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1e9) throw new BadRequest('Indica la tasa de cambio (mayor que 0)');
    rate = Math.round(rate * 1e6) / 1e6;
    if (rate <= 0) throw new BadRequest('Indica la tasa de cambio (mayor que 0)');
    amountBaseC = Math.round(amountR / rate * 100);
    if (amountBaseC < 1) throw new BadRequest('El monto es demasiado pequeño para esa tasa');
  }
  const cats = await getExpenseCategories(db, tenantId);
  const wanted = stripAccents(String(cleanText(body.category, 60, 'Categoría', true))).toLowerCase();
  const category = cats.find(c => stripAccents(c).toLowerCase() === wanted);
  if (!category) throw new BadRequest('Categoría no válida: elige una de la lista (se editan en Gastos)');
  let method = cleanText(body.method, 60, 'Método de pago', true);
  method = normalizeMethodName(method);
  if (isCreditMethod(method)) throw new BadRequest('Un gasto no se paga con saldo a favor de un cliente');
  const note = cleanText(body.note, 300, 'Nota', false);
  await assertCashOpen(db, tenantId, { days: [spentOn] });
  const { rows } = await db.query(`
    INSERT INTO expenses (tenant_id, spent_on, amount, currency, exchange_rate, amount_base, category, method, note, created_by)
    VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [tenantId, spentOn, amountR, currency, rate, amountBaseC / 100, category, method, note, createdBy]);
  return mapExpenseRow(rows[0]);
}

// Anula un gasto (DENTRO de una transacción). null si no existe en este negocio.
async function voidExpenseTx(db, tenantId, expenseId, reason) {
  const why = cleanText(reason, 200, 'Motivo', true);
  const { rows: [e] } = await db.query('SELECT spent_on FROM expenses WHERE id = $1 AND tenant_id = $2', [expenseId, tenantId]);
  if (!e) return null;
  await assertCashOpen(db, tenantId, { days: [e.spent_on] });
  const { rows } = await db.query(
    'UPDATE expenses SET voided_at = now(), void_reason = $3 WHERE id = $1 AND tenant_id = $2 AND voided_at IS NULL RETURNING *', [expenseId, tenantId, why]);
  if (!rows[0]) throw new BadRequest('Este gasto ya fue anulado');
  return mapExpenseRow(rows[0]);
}

// ── Existencias ───────────────────────────────────────────────
// Suma `delta` al nivel de (producto, variante) y deja el movimiento, en la transacción de quien llama.
async function applyStockDelta(db, tenantId, productId, variantKey, delta, reason, { orderId = null, note = null, createdBy = 'owner' } = {}) {
  if (!delta) return null;
  if (!STOCK_REASONS.includes(reason)) throw new Error('Motivo de movimiento inválido: ' + reason);
  const { rows: [lv] } = await db.query(`
    INSERT INTO stock_levels (tenant_id, product_id, variant_key, qty) VALUES ($1, $2, $3, $4)
    ON CONFLICT (tenant_id, product_id, variant_key) DO UPDATE SET qty = stock_levels.qty + EXCLUDED.qty, updated_at = now()
    RETURNING qty`, [tenantId, productId, variantKey, delta]);
  const { rows: [mv] } = await db.query(`
    INSERT INTO stock_movements (tenant_id, product_id, variant_key, delta, qty_after, reason, order_id, note, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [tenantId, productId, variantKey, delta, lv.qty, reason, orderId, note, createdBy]);
  return { level: lv.qty, movement: mv };
}
const byKeyOrder = (a, b) => a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : a.variantKey < b.variantKey ? -1 : a.variantKey > b.variantKey ? 1 : 0;

// Lo que un pedido tiene descontado ahora mismo, por (producto, variante): −Σ movimientos del pedido
async function orderDeducted(db, tenantId, orderId) {
  const { rows } = await db.query(`
    SELECT product_id, variant_key, -SUM(delta)::int AS ded FROM stock_movements
    WHERE tenant_id = $1 AND order_id = $2 GROUP BY product_id, variant_key`, [tenantId, orderId]);
  return new Map(rows.map(r => [r.product_id + '|' + r.variant_key, { productId: r.product_id, variantKey: r.variant_key, ded: r.ded }]));
}

// Deja las existencias del pedido en lo que dicen sus líneas: descuenta lo que falta, devuelve lo que sobra.
// lines = [{ productId, variantKey, qty }] (las líneas FINALES del pedido; [] al anular). Solo cuentan productos con
// control de existencias. Misma función para crear, convertir, editar y anular: siempre es la diferencia.
async function syncOrderStock(db, tenantId, orderId, lines, reason, createdBy = 'owner') {
  const want = new Map();
  const ids = [...new Set(lines.filter(l => l.productId).map(l => l.productId))];
  if (ids.length) {
    const { rows } = await db.query('SELECT id FROM catalog_products WHERE tenant_id = $1 AND id = ANY($2::uuid[]) AND track_stock', [tenantId, ids]);
    const tracked = new Set(rows.map(r => r.id));
    for (const l of lines) {
      if (!l.productId || !tracked.has(l.productId)) continue;
      const k = l.productId + '|' + (l.variantKey || '');
      const cur = want.get(k) || { productId: l.productId, variantKey: l.variantKey || '', qty: 0 };
      cur.qty += Number(l.qty) || 0;
      want.set(k, cur);
    }
  }
  const had = await orderDeducted(db, tenantId, orderId);
  const keys = [...new Set([...want.keys(), ...had.keys()])];
  const todo = [];
  for (const k of keys) {
    const w = want.get(k), h = had.get(k);
    const diff = (w ? w.qty : 0) - (h ? h.ded : 0);
    if (diff !== 0) todo.push({ productId: (w || h).productId, variantKey: (w || h).variantKey, delta: -diff });
  }
  todo.sort(byKeyOrder);
  for (const x of todo) await applyStockDelta(db, tenantId, x.productId, x.variantKey, x.delta, reason, { orderId, createdBy });
  return todo.length;
}

// Devolución por artículos: devuelve las unidades al almacén, sin pasarse de lo que el pedido tenía descontado.
async function restoreReturnedStock(db, tenantId, orderId, returned, note, createdBy = 'owner') {
  const ids = returned.map(r => r.orderItemId).filter(Boolean);
  if (!ids.length) return 0;
  const { rows } = await db.query(
    'SELECT id, product_id, variant_key FROM order_items WHERE tenant_id = $1 AND order_id = $2 AND id = ANY($3::uuid[]) AND product_id IS NOT NULL', [tenantId, orderId, ids]);
  const info = new Map(rows.map(r => [r.id, r]));
  const want = new Map();
  for (const r of returned) {
    const it = info.get(r.orderItemId);
    if (!it) continue;
    const k = it.product_id + '|' + (it.variant_key || '');
    const cur = want.get(k) || { productId: it.product_id, variantKey: it.variant_key || '', qty: 0 };
    cur.qty += r.qty;
    want.set(k, cur);
  }
  if (!want.size) return 0;
  const had = await orderDeducted(db, tenantId, orderId);
  const todo = [];
  for (const [k, w] of want) {
    const ded = had.get(k) ? had.get(k).ded : 0;
    const back = Math.min(w.qty, Math.max(0, ded));
    if (back > 0) todo.push({ productId: w.productId, variantKey: w.variantKey, delta: back });
  }
  todo.sort(byKeyOrder);
  for (const x of todo) await applyStockDelta(db, tenantId, x.productId, x.variantKey, x.delta, 'return', { orderId, note, createdBy });
  return todo.length;
}

// Ajuste manual: { productId, variantKey | size+color, delta (≠ 0, con signo) | count (≥ 0), note (motivo) }
async function adjustStockTx(db, tenantId, body, createdBy = 'owner') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Datos del ajuste inválidos');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!UUID.test(String(body.productId || ''))) throw new BadRequest('Producto no encontrado');
  const { rows: [p] } = await db.query('SELECT id, name, track_stock FROM catalog_products WHERE id = $1 AND tenant_id = $2', [body.productId, tenantId]);
  if (!p) throw new BadRequest('Producto no encontrado');
  if (!p.track_stock) throw new BadRequest('Activa el control de existencias de este producto antes de ajustarlas');
  const hasDelta = body.delta !== undefined && body.delta !== null && body.delta !== '';
  const hasCount = body.count !== undefined && body.count !== null && body.count !== '';
  if (hasDelta === hasCount) throw new BadRequest('Indica la cantidad a sumar o restar, o el conteo (solo uno de los dos)');
  const note = cleanText(body.note, 200, 'Motivo', true);
  const variantKey = (body.size !== undefined || body.color !== undefined)
    ? buildVariantKey(body.size, body.color) : normVariantKey(body.variantKey);
  if (body.reason !== undefined && body.reason !== null && !['adjust_in', 'adjust_out', 'count'].includes(body.reason)) throw new BadRequest('Motivo de ajuste inválido');
  // La fila del nivel se bloquea para que dos ajustes simultáneos (o un ajuste y una venta) no pisen el cálculo del conteo
  await db.query(`INSERT INTO stock_levels (tenant_id, product_id, variant_key, qty) VALUES ($1, $2, $3, 0) ON CONFLICT DO NOTHING`, [tenantId, p.id, variantKey]);
  const { rows: [cur] } = await db.query(
    'SELECT qty FROM stock_levels WHERE tenant_id = $1 AND product_id = $2 AND variant_key = $3 FOR UPDATE', [tenantId, p.id, variantKey]);
  const { rows: [nk] } = await db.query('SELECT COUNT(*)::int AS n FROM stock_levels WHERE tenant_id = $1 AND product_id = $2', [tenantId, p.id]);
  if (nk.n > MAX_VARIANTS_PER_PRODUCT) throw new BadRequest(`Un producto admite hasta ${MAX_VARIANTS_PER_PRODUCT} variantes con existencias`);
  let delta, reason;
  if (hasDelta) {
    const n = payNum(body.delta);
    if (!Number.isInteger(n) || n === 0 || Math.abs(n) > MAX_STOCK_QTY) throw new BadRequest('La cantidad debe ser un número entero distinto de 0');
    delta = n; reason = n > 0 ? 'adjust_in' : 'adjust_out';
    if (body.reason && body.reason !== reason) throw new BadRequest('El motivo no coincide con el signo de la cantidad');
  } else {
    const n = payNum(body.count);
    if (!Number.isInteger(n) || n < 0 || n > MAX_STOCK_QTY) throw new BadRequest('El conteo debe ser un número entero de 0 o más');
    delta = n - cur.qty; reason = 'count';
    if (body.reason && body.reason !== 'count') throw new BadRequest('El motivo no coincide con un conteo');
  }
  if (delta === 0) return { productId: p.id, variantKey, level: cur.qty, movement: null, unchanged: true };
  const r = await applyStockDelta(db, tenantId, p.id, variantKey, delta, reason, { note, createdBy });
  return { productId: p.id, variantKey, level: r.level, movement: mapMovementRow(r.movement), unchanged: false };
}

function mapMovementRow(r) {
  return {
    id: r.id, productId: r.product_id, variantKey: r.variant_key, delta: r.delta, qtyAfter: r.qty_after, reason: r.reason,
    orderId: r.order_id, orderNumber: r.order_num === undefined || r.order_num === null ? null : (r.order_kind === 'quote' ? 'P-' : '#') + String(r.order_num).padStart(4, '0'),
    note: r.note, createdBy: r.created_by, createdAt: r.created_at,
  };
}

module.exports = {
  BadRequest, ensureStockExpensesSchema, DEFAULT_EXPENSE_CATEGORIES, MAX_EXPENSE_CATEGORIES, cleanExpenseCategories, getExpenseCategories,
  buildVariantKey, normVariantKey, productVariants,
  lockTenantForCash, businessDay, assertCashOpen, computeCashExpected, getCashDay, closeCashDay, reopenCashDay, mapClosing,
  mapExpenseRow, addExpenseTx, voidExpenseTx,
  applyStockDelta, syncOrderStock, restoreReturnedStock, adjustStockTx, mapMovementRow, orderDeducted,
  tzOf, DEFAULT_TIMEZONE, shiftDay, isRealDate, money2, centsOf,
};
