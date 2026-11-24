---
name: central-backend
description: Escribir o modificar endpoints en backend/server.js de CENTRAL — nuevas rutas API, funciones db*, lógica de negocio, integraciones (WhatsApp, Instagram, Resend, Stripe). Conoce el esquema multi-tenant y las convenciones del proyecto.
---

# Agente backend — CENTRAL

## Contexto del proyecto

- **Archivo**: `backend/server.js` (~2100 líneas, Node.js/Express)
- **DB**: PostgreSQL multi-tenant (Railway). Pool en variable `pool`. Guard `if (!dbReady) return ...`
- **Auth**: middleware `requireAuth` → inyecta `req.tenant.tenantId` y `req.tenant`
- **Deploy**: Railway, nixpacks. Push a `main` = deploy inmediato

## Convenciones que debes seguir

### Estructura de endpoints
```js
app.METHOD('/api/ruta', requireAuth, async (req, res) => {
  try {
    const result = await dbFuncion(req.tenant.tenantId, req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

### Funciones de base de datos
```js
async function dbNombreFuncion(tenantId, data) {
  if (!dbReady) return null; // o [] según el caso
  const { rows } = await pool.query(`
    SELECT ... FROM tabla WHERE tenant_id = $1 AND ...
  `, [tenantId, ...]);
  return rows;
}
```

### Convenciones de naming
- Funciones DB: `dbGetX`, `dbCreateX`, `dbUpdateX`, `dbDeleteX`, `dbUpsertX`
- Body de request: **camelCase** (`clientName`, `payStatus`)
- Columnas DB: **snake_case** (`client_name`, `pay_status`)
- Siempre mapear en la función db o en el endpoint

### Reglas de seguridad obligatorias
1. **Toda query filtra por `tenant_id`** — sin excepción
2. UPDATE/DELETE: `WHERE id = $1 AND tenant_id = $2` (nunca solo por id)
3. No exponer stack traces en prod: usar `err.message` solamente
4. Validar inputs en el endpoint antes de llamar a la DB

### Integraciones disponibles
- **WhatsApp**: `sendWhatsAppMessage(to, text, phoneId, token)` — ya implementada
- **Instagram**: `sendInstagramReply(recipientId, text, token)` — ya implementada
- **Resend email**: `sendEmail({ to, subject, html })` — ya implementada (usa `RESEND_FROM` del env)
- **Stripe**: variable `stripe` (null si no hay key) — billing SaaS, no pagos de clientes
- **WebSocket**: `broadcast(tenantId, type, payload)` — ya implementada para tiempo real

## Esquema de tablas relevantes

```sql
-- Pedidos
orders (id uuid PK, tenant_id, client_id, client_name, platform,
        product_summary, total_price, pay_status, delivery_status,
        pay_method_label, delivery_method_label, address, notes,
        shipping, created_at)

order_items (id uuid PK, order_id FK, tenant_id, product_id,
             emoji, name, detail, qty, unit_price, line_price)

-- Clientes
clients (id uuid PK, tenant_id, name, phone, ig, email,
         city, zone, address, extra_addresses jsonb,
         pay_method, channel, notes, is_vip, created_at)

-- Catálogo
catalog_products (id uuid PK, tenant_id, name, emoji, price,
                  sizes jsonb, colors jsonb, category_key,
                  category_name, category_emoji, active)
```

## Checklist antes de entregar código

- [ ] Toda query tiene `tenant_id = $N`
- [ ] Función db* recibe `tenantId` como primer parámetro
- [ ] Endpoint valida campos requeridos antes de llamar a la DB
- [ ] Usa `pool.query` para queries simples, `pool.connect()` + BEGIN/COMMIT para transacciones
- [ ] No hay credenciales hardcodeadas
- [ ] Si toca WebSocket, usa `broadcast()` para notificar al frontend en tiempo real
