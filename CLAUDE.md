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
central-mvp-v63 (1) - copia.html   ← Frontend completo (SPA)
backend/
  server.js                         ← Backend Express (API + webhooks + WS)
  nixpacks.toml                     ← Config build Railway (Chromium)
  .env.example                      ← Todas las variables de entorno documentadas
  package.json
AGENTES.md                          ← Guía de uso de agentes Claude
```

## Convenciones de código

### Backend (`server.js`)
- Todas las funciones de BD siguen el patrón `dbNombreFuncion(tenantId, data)`
- Los endpoints usan `requireAuth` middleware que inyecta `req.tenant.tenantId`
- **Siempre filtrar por `tenant_id`** — es multi-tenant; una query sin filtro expone datos de otros negocios
- El body de POST/PATCH usa **camelCase** (`clientName`, `payStatus`, `deliveryStatus`)
- La BD devuelve **snake_case** (`client_name`, `pay_status`, `delivery_status`)
- Variables de entorno: todas documentadas en `backend/.env.example`

### Frontend (SPA)
- Patrón de carga: `loadRealX()` async → fallback a datos demo si falla
- `BACKEND_URL` es la constante con la URL del backend
- `apiAuthHeader()` devuelve `{ Authorization: 'Bearer <jwt>' }`
- `apiHeaders()` devuelve headers con Content-Type + Auth
- IDs del backend se guardan como `_backendId` en los objetos locales
- El startup llama todos los loaders en paralelo: `Promise.all([loadRealConversations(), loadRealCatalog(), loadRealClients(), loadRealOrders()])`

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
| Informes | `realInfData` | `loadRealInformes(period)` | `GET /api/reports?period=` |
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
