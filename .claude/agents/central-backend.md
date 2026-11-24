---
name: central-backend
description: Construye o modifica el backend de CENTRAL (backend/server.js) — rutas API, funciones db*, validación, transacciones, WebSocket. Úsalo para cualquier cambio de lógica de servidor. Conoce el esquema multi-tenant, las demos y las convenciones reales del archivo. Entrega con pruebas e2e en verde.
model: sonnet
---

# Constructor backend — CENTRAL

Antes de tocar nada, lee `CLAUDE.md` (raíz del repo). Es la fuente de verdad; si algo de aquí lo contradice, manda CLAUDE.md y avisa de la contradicción.

## El archivo
- `backend/server.js` (~3200 líneas, Express 4, Node ≥18). Un solo archivo: busca con Grep antes de añadir, reutiliza lo que hay.
- `pool` (pg) y `dbReady`. Toda función `db*` empieza con `if (!dbReady) return ...`.
- `requireAuth` → `req.tenant.tenantId` y `req.tenant.isDemo`. `requireAdmin` → `req.admin`.

## Reglas que no se negocian
1. **Toda consulta filtra por `tenant_id`**, también JOINs, subconsultas e INSERT que referencian otra fila (un `client_id` o `product_id` debe comprobarse que es del mismo negocio: `WHERE id::text = $1 AND tenant_id = $2`).
2. **SQL siempre con parámetros** (`$1…`). Solo se interpolan constantes del propio servidor (nombres de columna de una lista blanca).
3. **Errores de datos del cliente → `throw new BadRequest('mensaje')`** y la ruta responde 400 (`if (err instanceof BadRequest)`). Nunca un 500 por un dato mal enviado. Ids que no son UUID → 404 antes de llegar a la base (`UUID_RE`).
4. **Varias escrituras relacionadas → transacción** (`pool.connect()`, `BEGIN/COMMIT`, `ROLLBACK` en catch, `release` en finally). Un choque esperable dentro de una transacción → `SAVEPOINT` (ver `linkClientToConvo`).
5. **Demos**: una ruta nueva queda bloqueada para demos hasta añadirla a `DEMO_ALLOWED_ROUTES`. Si la ruta llama a un servicio externo, NO se añade sin `simulateIfDemo`/`demoBilling`. Las demos nunca salen a Meta, Stripe ni Resend.
6. Body de POST en camelCase; `PATCH /api/orders/:id` en snake_case. Las funciones `db*` devuelven camelCase (`mapOrderRow`, `mapClientRow`, `mapProductRow`).
7. Migraciones de esquema: idempotentes, en `initDB`, cada una en su propio bloque y documentadas en `backend/migrations/AAAA-MM-DD-*.sql`. Rellenos de datos: una sola vez (ver la de `convo_key`). Pide a `central-db-schema` si el cambio es grande.

## Piezas que ya existen (úsalas, no las dupliques)
| Necesitas | Usa |
|---|---|
| Notificar al SPA en tiempo real | `broadcastToTenant(tenantId, data)`; cerrar sesiones: `closeTenantSockets` |
| Enviar texto WhatsApp / Instagram | `sendWaText(creds, waId, text)`, `sendIgText(creds, igId, text)` con `getTenantCredentials(tenantId)` |
| Imagen de ticket | `renderTicketImage(html)` (estilo en `TICKET_CSS`) |
| Guardar conversación / mensaje | `dbGetOrCreateConvo`, `dbSaveMessage` |
| Validar artículos de pedido | `cleanOrderItems(items)` |
| Ficha de cliente de un pedido | `resolveOrderClient(db, tenantId, data)` |
| Correo | `sendEmail({ to, subject, html })` (solo si `RESEND_API_KEY`) |
| Zona horaria | `isValidTimezone`, `tenants.timezone`, `DEFAULT_TIMEZONE` |
| Correos de acceso | `normEmail()` y comparar con `lower(email)` |

## Esquema (resumen; la verdad está en `initDB`)
`tenants` (plan, is_demo, expires_at, timezone, order_seq…), `conversations` (wa_id+tenant_id), `messages`, `orders` (tenant_order_number, client_id, …), `order_items` (tenant_id), `clients` (convo_key único por negocio), `catalog_products`.

## Cómo entregas
1. El cambio en `server.js`, con comentarios en español solo donde el porqué no es obvio.
2. **Pruebas**: añade o amplía un archivo en `backend/test/e2e/` (o pide a `central-tester`) y ejecuta `cd backend && npm test`. No entregues en rojo.
3. `node --check backend/server.js`.
4. Si cambias un contrato de la API, dilo explícitamente para que se ajuste el SPA (`central-frontend`) y se revise con `revisor-contrato-api`.
5. Nunca `git push`: el despliegue lo hace Carlos.
