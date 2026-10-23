# CENTRAL — Instrucciones para Claude Code

## Qué es este proyecto

**CENTRAL** es una web app de gestión de pedidos, clientes y mensajería para pequeños negocios en Latinoamérica.
- **Frontend**: SPA de un solo archivo HTML (`central-mvp-v63 (1) - copia.html`, ~600 KB, vanilla JS/CSS)
- **Backend**: Node.js/Express (`backend/server.js`, ~2100 líneas, v5.0)
- **Base de datos**: PostgreSQL multi-tenant en Railway
- **Deploy**: Railway (push a `main` = auto-deploy a producción)

## Stack técnico

| Capa | Tecnología |
|------|------------|
| Frontend | HTML + CSS + JS vanilla (SPA sin build) |
| Backend | Node.js 18, Express 4 |
| Base de datos | PostgreSQL (Railway), multi-tenant por `tenant_id` |
| Auth | JWT 30 días, `localStorage` key: `central_jwt` |
| Email | Resend API (fetch directo, sin SDK) |
| Mensajería | WhatsApp Business API + Instagram Graph API |
| Tiempo real | WebSocket (ws), auto-reconexión |
| PDF tickets | Puppeteer + Chromium (nixpacks.toml) |
| Pagos | Stripe (billing SaaS, no pagos de clientes) |
| Deploy | Railway + nixpacks |

## Archivos clave

```
backend/                              ← LO QUE SE DESPLIEGA EN RAILWAY
  server.js                           ← Backend Express (API + webhooks + WS)
  central-mvp-v63 (1) - copia.html    ← SPA de producción (solo se sirve en /app con JWT)
  central-registro.html               ← Login / registro
  central-admin.html                  ← Panel superadmin (Dashboard, Negocios, Demos)
  demo-seed.js                        ← Datos ficticios de las cuentas demo
  nixpacks.toml, .env.example, package.json
central-mvp-v63 (1) - copia.html      ← Copia ANTIGUA de la raíz, NO se despliega — no editar
index.html, solicitud.html, …         ← Sitio público (solicitud por Formspree)
AGENTES.md                            ← Guía de uso de agentes Claude
```

**Edita siempre la copia de `backend/`.** La raíz tiene versiones antiguas de algunos HTML.

## Demos para prospectos

- Se crean desde `central-admin.html` → Demos (sesión superadmin + `DEMO_CREATION_KEY`).
- `tenants.is_demo = true`, `expires_at` → login, API y `/app` rechazan la cuenta al caducar.
- En demos, los envíos a WhatsApp/Instagram se simulan (`simulateIfDemo`): nunca salen a Meta.
- El SPA muestra un banner con los días restantes (`window.__DEMO_MODE__`, inyectado en `/app`).

## Seguridad del servidor

- Estáticos por lista blanca (`PUBLIC_STATIC` en server.js): solo .html públicos e imágenes. Nunca .js/.json.
- Rate limit en `/api/tenant/login` y `/api/admin/login`.

## Convenciones de código

### Backend (`server.js`)
- Todas las funciones de BD siguen el patrón `dbNombreFuncion(tenantId, data)`
- Los endpoints usan `requireAuth` middleware que inyecta `req.tenant.tenantId`
- **Siempre filtrar por `tenant_id`** — es multi-tenant; una query sin filtro expone datos de otros negocios
- El body de POST/PATCH usa **camelCase** (`clientName`, `payStatus`, `deliveryStatus`)
- Las funciones `db*` de pedidos, clientes y catálogo devuelven **camelCase** a la API (la BD es snake_case)
- Variables de entorno: todas documentadas en `backend/.env.example`

### Frontend (SPA)
- Patrón de carga: `loadRealX()` async → fallback a datos demo si falla
- `BACKEND_URL = location.origin` (SPA, login y API se sirven desde el mismo servidor)
- `apiAuthHeader()` devuelve `{ Authorization: 'Bearer <jwt>' }`
- `apiHeaders()` devuelve headers con Content-Type + Auth
- IDs del backend se guardan como `_backendId` en los objetos locales
- Arranque: `loadRealOrders()` (luego clientes), `loadRealConversations()` y `loadRealCatalog()`; el historial del cliente espera a que carguen los pedidos

## Reglas de trabajo

### Git y deploy
- **`git push` lo ejecuta Carlos** — push a `main` = deploy inmediato a producción; NO hacer push sin que Carlos lo pida explícitamente
- Hacer commit de cada grupo lógico de cambios antes de pasar al siguiente
- Mensajes de commit en inglés, imperativo, máx 72 chars en la primera línea

### Seguridad
- No hardcodear credenciales, tokens ni URLs de producción
- No commitear `.env` (está en `.gitignore`)
- Toda nueva tabla/columna debe tener `tenant_id` con FK a `tenants`

### Base de datos
- Producción está en Railway — usar `railway run` para consultas directas
- No ejecutar migraciones destructivas sin respaldo previo
- Para cambios de esquema con datos reales: usar el agente `db-migration-helper`

### Costos
- Confirmar con Carlos antes de cualquier acción que genere costo real (Twilio, Resend en volumen, Stripe, Railway add-ons)
- Llamadas solo a Claude/Anthropic API están preaprobadas

## Módulos del frontend

| Vista | Variable clave | Loader | Endpoints |
|-------|---------------|--------|-----------|
| Inbox (conversaciones) | `convos` | `loadRealConversations()` | `GET /api/conversations` |
| Pedidos | `orders` | `loadRealOrders()` | `GET/POST /api/orders`, `PATCH /api/orders/:id` |
| Catálogo | `catalog` | `loadRealCatalog()` | `GET/POST /api/catalog`, `PATCH/DELETE /api/catalog/:id` |
| Clientes | `clientsDB` | `loadRealClients()` | `GET/POST /api/clients`, `PATCH/DELETE /api/clients/:id` |
| Informes | `getInfData(period)` | calculado en el navegador a partir de `orders` | (`GET /api/reports` existe pero el SPA no lo usa) |
| Ajustes | `businessProfile` | al cargar tenant | `GET/PATCH /api/tenant/profile` |

## Agentes disponibles

Ver `AGENTES.md` para la guía completa. Resumen rápido:

| Cuándo | Agente |
|--------|--------|
| Antes de commit/push | `code-reviewer` |
| Nuevo endpoint o lógica backend | `backend-node-pg` |
| Cambio de esquema DB con datos reales | `db-migration-helper` |
| Algo no funciona | `bug-hunter` |
| Antes de desplegar | `deploy-checklist` |
| Cambio de UI/pantalla | `revisor-diseno` |
| Queries SQL nuevas o modificadas | `revisor-aislamiento` |

## Variables de entorno requeridas (producción)

Ver `backend/.env.example` para la lista completa. Las críticas:
- `DATABASE_URL` — PostgreSQL Railway
- `JWT_SECRET` — clave de firma JWT
- `RESEND_API_KEY` + `RESEND_FROM` — email transaccional
- `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_TOKEN` — WhatsApp Business
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` — billing SaaS
