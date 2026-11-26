# CENTRAL — Instrucciones para Claude Code

## Qué es este proyecto

**CENTRAL** es una web app de gestión de pedidos, clientes y mensajería para pequeños negocios en Latinoamérica.
- **Frontend**: SPA de un solo archivo HTML (`central-mvp-v63 (1) - copia.html`, ~600 KB, vanilla JS/CSS)
- **Backend**: Node.js/Express (`backend/server.js`, ~3200 líneas, v5.0)
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
| Tickets (imagen PNG) | Puppeteer + Chromium (nixpacks.toml) |
| Pruebas | `npm test` (Node + Postgres local, Meta simulada) |
| Pagos | Stripe (billing SaaS, no pagos de clientes) |
| Deploy | Railway + nixpacks |

## Archivos clave

```
backend/                              ← LO QUE SE DESPLIEGA EN RAILWAY
  server.js                           ← Backend Express (API + webhooks + WS)
  central-mvp-v63 (1) - copia.html    ← SPA de producción (solo se sirve en /app con JWT)
  central-registro.html               ← Login / registro
  central-admin.html                  ← Panel superadmin (Dashboard, Negocios, Demos)
  reset-password.html                 ← Página del enlace de recuperación de clave
  demo-seed.js                        ← Datos ficticios de las cuentas demo
  pagos.js                            ← Esquema y reglas de pagos y del ciclo del pedido (Fases 2 y 3)
  operacion.js                        ← Gastos, cierre de caja, costo y existencias (Fase 4A): esquema + lógica transaccional
  migrations/AAAA-MM-DD-*.sql         ← SQL de cada cambio de esquema (initDB lo aplica solo; esto es para revisar/respaldar)
  test/                               ← Pruebas: run.js (npm test), e2e/, helpers/, servidor-local.js
  nixpacks.toml, .env.example, package.json
index.html, solicitud.html, …         ← Sitio público (solicitud por Formspree); serve.ps1 lo sirve en local (:4444)
.claude/agents/                       ← Agentes de CENTRAL (versionados); .claude/skills/ igual
AGENTES.md                            ← Guía de uso de agentes Claude
```

**La app, el login y el panel admin existen solo en `backend/`.** La raíz contiene únicamente la web pública; no crear copias de los HTML de la app fuera de `backend/`.

## Demos para prospectos

**Un solo servidor y un solo panel** (decisión de Carlos, 27-oct-2026): las demos viven en `central-backend` y su base `railway`, separadas por `tenant_id` como cualquier negocio. Se probó un servicio aparte (`central-demo`) y se eliminó por desorden: no volver a crear servicios, ramas ni carpetas duplicadas para las demos.
- Panel: https://central-backend-production.up.railway.app/central-admin.html → Demos.
- Se crean desde `central-admin.html` → Demos (sesión superadmin + `DEMO_CREATION_KEY`).
- `tenants.is_demo = true`, `expires_at` → login, API y `/app` rechazan la cuenta al caducar.
- En demos, los envíos a WhatsApp/Instagram se simulan (`simulateIfDemo`): nunca salen a Meta.
- El SPA muestra un banner con los días restantes (`window.__DEMO_MODE__`, inyectado en `/app`). `/app` también inyecta `window.__TENANT_PLAN__` en todas las cuentas, para que el menú del plan sea correcto desde el primer instante.
- **Aislamiento (no romper):**
  - `DEMO_ALLOWED_ROUTES` en server.js es una **lista blanca**: una demo solo puede usar esas rutas; cualquier ruta nueva queda bloqueada para demos (`demo_blocked`) hasta añadirla a propósito. No añadas rutas que llamen a servicios externos.
  - Facturación de demos con `demoBilling`: el cambio de plan (basic/pro/business) se guarda directo, **nunca** se llama a Stripe. Las demos arrancan en `business`.
  - Las demos no pueden conectar WhatsApp/Instagram, descargar media de Meta, recibir correos de recuperación ni cambiar su correo de acceso. Límite de 1 MB por petición y de filas por tabla.
  - `/app` inyecta para demos un aislador de `localStorage` (claves con prefijo `central_demo_<tenantId>__`) y quita del HTML las conversaciones de ejemplo originales de la app.
- **Datos de ejemplo:** `demo-seed.js` es 100 % inventado. `node backend/test/demo-data.test.js` comprueba que no coincide con datos originales; ejecútalo si tocas el seed. Panel admin → "Reiniciar datos" vuelve a sembrar una demo.
- **Las demos no se mezclan con lo real:** las métricas y la lista "Negocios" del panel excluyen `is_demo`. "Hacer real" borra todos los datos de ejemplo (`wipeDemoData`) y deja la cuenta vacía en plan `basic`.

## Seguridad del servidor

- Estáticos por lista blanca (`PUBLIC_STATIC` en server.js): solo .html públicos e imágenes. Nunca .js/.json.
- Rate limit en `/api/tenant/login` y `/api/admin/login`.
- `POST /webhook` exige la firma de Meta (`X-Hub-Signature-256`, clave `META_APP_SECRET`; opcional `INSTAGRAM_APP_SECRET`). Sin la variable, en producción rechaza todo. Un mensaje de un número/cuenta sin negocio asociado se descarta (no hay reenvío a todos).
- El WebSocket solo envía datos tras `{type:'auth'}` con JWT válido; sin autenticar se cierra a los 10 s.
- En producción el servidor no arranca sin `JWT_SECRET`. `WEBHOOK_VERIFY_TOKEN` no tiene valor por defecto.
- SPA: todo dato de clientes/contactos/productos que vaya a `innerHTML` pasa por `escHtml()` (y `escJsAttr()` dentro de `onclick`). Mantenerlo en código nuevo.
- `/api/media/:id` solo entrega archivos de mensajes del propio tenant; el SPA los descarga con `fetch` + token (`loadAuthedMedia`).
- Contraseñas: `PUT /api/tenant/password {currentPassword,newPassword}` (no está en `DEMO_ALLOWED_ROUTES`). Cambiar el correo en `PUT /api/tenant/profile` exige `currentPassword`. Ambas pasan por `checkCurrentPassword`: freno por negocio de 5 fallos/15 min → 429; el intento se cuenta **antes** del `compare` para que peticiones en paralelo no lo esquiven. bcrypt solo lee 72 bytes: toda ruta que fija una contraseña rechaza más con `pwTooLong` (400), nunca la recorta.
- Plan: `POST /api/tenant/register` crea siempre la cuenta en `basic` y devuelve `requestedPlan` (`'pro'|'business'|null`); `requireAuth` lee el plan de la BD (no del JWT). `GET /api/reports` responde 403 `{error:'plan_required'}` en `basic`.
- Arranque: `initDB` no debe construir índices grandes. Esos van en `BACKGROUND_INDEXES` y `ensureIndexes()` los crea con `CREATE INDEX CONCURRENTLY` **después de `listen`**, con advisory lock (una réplica a la vez); un índice inválido se borra y se rehace. Lista completa en «Arranque del ciclo». La migración de `orders.discount` hace `process.exit(1)` si la columna no queda creada (los pedidos fallarían sin ella).

## Convenciones de código

### Backend (`server.js`)
- Todas las funciones de BD siguen el patrón `dbNombreFuncion(tenantId, data)`
- Los endpoints usan `requireAuth` middleware que inyecta `req.tenant.tenantId`
- **Siempre filtrar por `tenant_id`** — es multi-tenant; una query sin filtro expone datos de otros negocios
- **Pagos:** `PATCH /api/orders/:id` ya NO acepta `pay_status` (400). El estado de cobro (`pay_status` pend|partial|ok y `orders.amount_paid`, en moneda base) lo deriva el servidor de `payments` con `recalcOrderPayment` (pagos.js), con una SUM dentro de la misma transacción, nunca por incremento. `POST /api/orders` ignora `payStatus` y acepta `initialPayment {amount | full:true, method, …}`.
- El body de POST usa **camelCase** (`clientName`, `payStatus`, `deliveryStatus`). Excepción: `PATCH /api/orders/:id` recibe **snake_case** (`delivery_status`, `pay_status`…), que es lo que envía el SPA
- Las funciones `db*` de pedidos, clientes y catálogo devuelven **camelCase** a la API (la BD es snake_case)
- Variables de entorno: todas documentadas en `backend/.env.example`

- Índices grandes (tablas que crecen): añadirlos a `BACKGROUND_INDEXES`, no a `initDB` (ver "Seguridad del servidor → Arranque"); su `.sql` en `migrations/` los documenta con `CONCURRENTLY`.
- Errores de datos del cliente: `throw new BadRequest('…')` → 400. Ids que no son UUID → 404 (`UUID_RE`). Nunca un 500 por un dato mal enviado.
- Varias escrituras relacionadas → transacción; un choque esperable dentro de ella → `SAVEPOINT`.

### Frontend (SPA)
- `BACKEND_URL = location.origin` (SPA, login y API se sirven desde el mismo servidor). Cabeceras: `apiAuthHeader()` / `apiHeaders()`.
- Código nuevo habla con la API con **`apiJson(method, path, body)`** (lanza Error con el mensaje del servidor).
- Los objetos locales usan el **id del servidor** (`id`); un id temporal (`c123`, `p123`) nunca se envía (`isServerId`).
- Cargas: `loadRealX()` async; si fallan → `notifyLoadError('…')` (aviso al usuario). **No hay datos de ejemplo de respaldo** en cuentas reales (tampoco en Inbox ni Pagos).
- Diálogos y avisos: `askConfirm()`, `openFormDialog()` y `showToast(msg,'error')`; no usar `confirm()`/`alert()`/`prompt()` del navegador.
- `central_profile` (localStorage) lleva `tenantId`; si no coincide con el del JWT se descarta. Tras registrarse con plan de pago, el SPA guarda `central_pending_plan` en sessionStorage y abre Ajustes → Plan para pagar.
- Arranque: `loadRealOrders()` → `loadRealClients()` (en cadena, `ordersReady`), `loadRealConversations()`, `loadRealCatalog()`; el historial del chat espera a pedidos y clientes.
- Diseño: imitar el layout existente (indicadores en fila, mismo tamaño; repartir la información en la tarjeta); colores solo con variables CSS.

## Cómo probar

- **`cd backend && npm test`**: unitarias (`test/*.test.js`) + e2e (`test/e2e/*.test.js`). Para las e2e crea una base **nueva y vacía** (`central_test`) en el Postgres **local**, arranca `server.js` con Meta simulada (`test/helpers/mock-meta.js`) y lo borra todo al terminar. `npm test -- informes` filtra por nombre.
- **Se niega a usar una base que no sea local** (`assertLocalDb`): nunca apuntar las pruebas a Railway.
- Postgres local: `cd backend && node test/pg-local.js start | stop | status` (datos en `%USERPROFILE%\.central-pg`, puerto 55432; `TEST_DATABASE_URL` para otro). Detalle: skill `probar-central`.
- **Probar a mano en el navegador**: `node backend/test/servidor-local.js` (launch `central-local`, http://localhost:3999, admin `admin@test.local` / `adminpass`), base local persistente `central_dev`, sin claves reales.
- Todo cambio de backend llega con su prueba e2e (agente `central-tester`). Cambio de SPA: comprobado en el navegador (flujo feliz, fallo del servidor, doble clic).
- Datos de demo: `node backend/test/demo-data.test.js` (incluido en `npm test`).

## Flujo de un cambio

1. **Construir** con el agente que toca (tabla de agentes) — en cambios grandes, `central-funcionalidad` entrega primero un plan.
2. **Probar**: `npm test` en verde + prueba manual si hay pantalla.
3. **Revisar** con los revisores que apliquen (en paralelo): `revisor-multitenant` si cambia SQL, `revisor-seguridad`, `revisor-contrato-api` si cambia una ruta o su uso, `revisor-demos` si cambian rutas/envíos/facturación/seed, `revisor-escala` si hay listas, informes o migraciones, `revisor-diseno` si hay pantalla nueva. Corregir lo que encuentren y volver a probar.
4. **Documentar** (`central-docs`): CLAUDE.md, AGENTES.md, `.env.example`, `migrations/`.
5. **Control de despliegue** (`central-deploy`): veredicto y pasos para Carlos (respaldo si hay migración).
6. **Carlos hace el push.**

## Reglas de trabajo

### Git y deploy
- **`git push` lo ejecuta Carlos** — push a `main` = deploy inmediato a producción; NO hacer push sin que Carlos lo pida explícitamente. En este equipo `git push` está además bloqueado en los permisos locales (`.claude/settings.local.json` → `deny`).
- Hacer commit de cada grupo lógico de cambios antes de pasar al siguiente
- Mensajes de commit en inglés, imperativo, máx 72 chars en la primera línea

### Seguridad
- No hardcodear credenciales, tokens ni URLs de producción
- No commitear `.env` (está en `.gitignore`)
- Toda nueva tabla/columna debe tener `tenant_id` con FK a `tenants`

### Base de datos
- Producción está en Railway — usar `railway run` para consultas directas
- No ejecutar migraciones destructivas sin respaldo previo. **Railway no tiene Backups activados**: el respaldo lo hace Carlos con `backend/scripts/respaldo-produccion.ps1` (pg_dump de solo lectura → `Desktop\CENTRAL-respaldos\`; incluye las tablas de Kisses, no compartir el archivo)
- Para cambios de esquema con datos reales: usar el agente `central-db-schema` (migración idempotente en `initDB` + `migrations/*.sql`; rellenos de datos una sola vez)

### Costos
- Confirmar con Carlos antes de cualquier acción que genere costo real (Twilio, Resend en volumen, Stripe, Railway add-ons)
- Llamadas solo a Claude/Anthropic API están preaprobadas

## Módulos del frontend

| Vista | Variable clave | Loader | Endpoints |
|-------|---------------|--------|-----------|
| Inbox (conversaciones) | `convos` | `loadRealConversations()` | `GET /api/conversations` |
| Pedidos | `orders` | `loadRealOrders()` | `GET/POST /api/orders`, `PATCH /api/orders/:id` |
| Catálogo | `catalog` | `loadRealCatalog()` | `GET/POST /api/catalog`, `PATCH/DELETE /api/catalog/:id` |
| Clientes | `clientsDB` | `loadRealClients()` | `GET/POST /api/clients`, `PATCH/DELETE /api/clients/:id` (cada ficha trae `balance`: saldo por cobrar, y `credit`: saldo a favor) |
| Informes | `fetchInfData()` | `renderInforme(tab)` (asíncrono) | `GET /api/reports?period=&canal=&from=&to=` — lo calcula el servidor en la zona horaria de la ubicación del negocio (un `tz` que mande un cliente antiguo se ignora); incluye `cobrado` y `cobrosPorMetodo` |
| Ajustes | `businessProfile` | al cargar tenant | `GET/PUT /api/tenant/profile` |
| Ajustes de cobro y entrega | `tenantSettings` | al cargar tenant | `GET/PUT /api/tenant/settings` (`paymentMethods`, `deliveryMethods` con lista blanca, `baseCurrency`, `tax`, `zones`, `expenseCategories`; `timezone` solo se lee); panel Ajustes → «Impuesto y zonas» |
| Ciclo del pedido | detalle del pedido (`openOrderDetail`) | al abrir | `POST /api/orders/:id/convert`, `/cancel`, `/returns`; `GET /api/orders/:id/returns`; `GET /api/clients/:id/credit` |
| Pagos | pantalla Pagos + modal del pedido | al abrir | `GET /api/payments?period=` o `from=&to=` más `&method=`; `GET/POST /api/orders/:id/payments`; `POST /api/payments/:id/void`; `GET /api/orders/:id/events` |
| Ubicación del negocio | Ajustes → Ubicación | al cargar tenant | `GET/PUT /api/tenant/profile` (`country`, `timezone`; el GET trae `timezoneOptions`) |
| Gastos y Caja | pantalla Gastos (Pro y Business); la tarjeta de caja va arriba | `loadGastos()` | `GET /api/expenses?period=` o `from=&to=` más `&category=`; `POST /api/expenses`; `POST /api/expenses/:id/void`; categorías en `GET/PUT /api/tenant/settings` (`expenseCategories`) |
| Cierre de caja | tarjeta `#cajaCard` dentro de Gastos (no en Pagos: Pagos es solo Business) | `loadCaja()` | `GET /api/cash/:day`; `POST /api/cash/:day/close`, `/reopen`; `GET /api/cash?from=&to=` |
| Existencias | Catálogo (`stockLevels`, ventana `openStockDialog`) | `loadStockLevels()` | `GET /api/stock[?productId=]`; `POST /api/stock/adjust`; `GET /api/stock/movements`; `cost` y `trackStock` en `POST/PATCH /api/catalog` |
| Utilidad | Informes → pestaña Utilidad | `fetchUtilidadData()` | `GET /api/reports/profit?period=&canal=&from=&to=`; `GET /api/reports/receivables` (403 `plan_required` en `basic`; los gastos y la caja también: `planGate`) |
| Horario + respuesta automática | `autoReplyCfg` | `loadAutoReplyConfig()` | `GET/PUT /api/tenant/auto-reply` |

**Respuesta automática fuera de horario:** la envía el **servidor** (`maybeSendAutoReply` en el webhook), una vez por conversación y día en la zona horaria del negocio (`tenants.timezone`). Apagada por defecto (`auto_reply_enabled`). Llega al SPA como `message_sent` con `auto: true`.

**Pedidos:** el número visible (`#0001`) es `orders.tenant_order_number`, propio de cada negocio (contador `tenants.order_seq`). `order_number` (BIGSERIAL global) queda solo como respaldo. El SPA **primero guarda en el servidor** y usa el número que este devuelve (también en el ticket); nunca inventa números. `storeServerOrder()` es la única forma de meter un pedido del servidor en `orders`.
- **Pedido ↔ cliente por ficha (`orders.client_id`), nunca por nombre.** `POST /api/orders` acepta `clientId` (se comprueba que sea del negocio) o, si no hay ficha, `clientConvoKey`/`clientPhone` y el servidor la crea (`createdClient` en la respuesta). `clients.convo_key` une la ficha a su chat (waId o `ig_…`). En el SPA: `findClientForConvo()`, `relinkClientOrders()`. Renombrar una ficha actualiza `client_name` de sus pedidos.
- **Editar pedido:** `PATCH /api/orders/:id` (snake_case) acepta además `items` (reemplaza todos, validados con `cleanOrderItems`) y `client_id`; todo en una transacción. Errores de datos → `BadRequest` → 400.
- **Total y descuento:** `orders.discount` (NUMERIC ≥ 0, CHECK `orders_discount_nonneg`) llega como `discount` en POST (camelCase) y PATCH (snake_case). Con artículos el **servidor** calcula el total (`computeOrderAmounts`: `linePrice = unitPrice×qty`, subtotal = Σ líneas, base = max(0, subtotal − descuento), impuesto = round2(base × tasa / 100), total = subtotal − descuento + impuesto + envío; `computeOrderTotal` devuelve solo el total) e ignora `totalPrice` del cliente; sin artículos respeta el total enviado. Descuento > total → 400. Al editar usa la `tax_rate` del propio pedido (la foto), no el ajuste actual del negocio.
- **Pagos (SPA):** resumen de cobros (`renderPagosResumen`), ventana «Registrar pago» (`openPaymentDialog`), lista de pagos y anulación en el detalle del pedido.
- **Formulario único (Fase 3):** crear pedido, crear presupuesto y editar son UN solo componente (`openOrderForm({mode, kind, convoKey, orderId})`, modal `#ofModal`, estado `OF`). Se abre desde el chat (`convoKey`: cliente y conversación ya rellenados, ticket por el canal) y desde Pedidos. Primero guarda en el servidor (`ofSubmit`, bloqueo de doble clic) y usa el número que este devuelve. No volver a crear formularios aparte: los tres anteriores (modal del chat, panel de borrador `op-live`, modal de Pedidos, modal de edición) se eliminaron.
- **Guardados:** usar `apiJson()` (lanza Error con el mensaje del servidor). Altas y bajas esperan al servidor; cambios de estado son instantáneos y se deshacen si fallan (`patchOrder(id, fields, undo)`). Nada debe fallar en silencio.
- **Tickets:** el estilo (`TICKET_CSS`) vive en server.js; el SPA manda solo el contenido. En chats de Instagram se envía `igId` y el servidor publica la imagen en `/api/ticket-image/:token` (aleatorio, caduca a los 15 min) para que Meta la descargue.

**Pagos (Fase 2):** pagos parciales, anulaciones e historial por pedido. Reglas contables (no romper):
- **El dinero no se edita, se registra.** Los pagos solo se añaden o se anulan (`voided_at` + `void_reason`); nunca DELETE ni UPDATE de importes. Un error se corrige anulando y registrando de nuevo.
- No se cobra más que el saldo (`addPaymentTx`; pago completo = `full:true`) y no se baja el total de un pedido por debajo de lo cobrado (400).
- **Moneda base por negocio** (`tenants.base_currency`, por defecto USD): totales y saldos van en ella; no se puede cambiar si ya hay pagos. Un pago en otra moneda guarda `exchange_rate` y `amount_base`; solo `amount_base` cuenta para el saldo.
- Nombres de método **canónicos** (`normalizeMethodName` en pagos.js: "Pago móvil" = "Pago Móvil", "Efectivo $" = "Efectivo"): se normalizan al leer, para agrupar y filtrar.
- **Ajustes de métodos de pago y entrega en el servidor** (`tenant_settings`), no en localStorage. El SPA migra los viejos una sola vez (`migrateLocalSettings`), solo si el navegador los marcó antes como de este negocio (`central_last_tenant`); si no, los descarta. Entrega: lista blanca `DELIVERY_KEYS`.
- Historial: `order_events` (se ordena por `seq`, no solo por fecha).
- **Arranque:** `ensurePaymentsSchema` (solo DDL, con advisory lock, sin DDL si ya existe; 4 reintentos; `process.exit(1)` si falta el esquema) y `runPaymentsBackfill` (relleno por lotes de pedidos 'ok' antiguos sin pago). Sin la marca en `schema_migrations` espera antes de escuchar (primer despliegue); después corre en segundo plano tras `listen` y a los 10 min, para recoger lo que la versión vieja marque como pagado durante el solape. Índice `orders_legacy_paid_id_idx` en `BACKGROUND_INDEXES`.
- Demos: rutas de pagos en la lista blanca; topes `payments` 600 y `order_events` 5000; `wipeDemoData` borra `payments`, `order_events` y `tenant_settings`.

**Ciclo completo del pedido (Fase 3):** presupuestos, estados, anulación, impuesto, fecha/zona de entrega, devoluciones y saldo a favor. Todo en todos los planes (también `basic`). Esquema: `ensureOrderCycleSchema` (pagos.js) y `migrations/2026-11-26-ciclo-pedido.sql` (debe coincidir con ese DDL). Reglas (no romper):
- **Presupuestos:** `orders.kind` ('order'|'quote'). Contador propio `tenants.quote_seq` → `orders.quote_number`, se muestra `P-0001`; no tiene `tenant_order_number`. `POST /api/orders {kind:'quote'}`. `POST /api/orders/:id/convert` le asigna el siguiente número de pedido, pone `created_at = ahora` (cuenta en ventas desde la conversión) y registra `converted`. Un presupuesto no admite cobros ni devoluciones (400), no cuenta en informes, cobros, saldos ni en Pagos. Se puede anular (sin dinero). Sin conversión automática por «ACEPTO».
- **Estados:** `delivery_status` = `to_deliver|preparing|on_the_way|delivered|not_delivered|cancelled`. `cancelled` SOLO con `POST /api/orders/:id/cancel {reason (≤300), resolution:'refund'|'credit', refundMethod}`; `PATCH` nunca lo pone ni modifica un pedido anulado (400). Anular devuelve lo cobrado neto en la misma transacción; con `credit` el pedido necesita `client_id` (400 si no). Lo que se pagó con «Saldo a favor» vuelve siempre al saldo, nunca sale como efectivo. Los anulados quedan fuera de ventas, informes (`cancelados` = conteo real) y saldo del cliente.
- **Impuesto (se suma encima):** `tenant_settings.tax {enabled, rate 0–100, label ≤30}`; `orders.tax_rate`/`tax_amount` son una FOTO tomada al crear (el pedido editado usa la suya). `computeOrderAmounts`: base = max(0, subtotal − descuento); IVA = round(base × tasa); total = subtotal − descuento + IVA + envío (el envío no lleva impuesto). Los pedidos anteriores quedan con impuesto 0.
- **Entrega:** `orders.delivery_date` (DATE, `YYYY-MM-DD`; el servidor lo devuelve como texto, sin zona) y `delivery_zone` (≤60); `tenant_settings.zones [{name, cost?}]` (máx. 50). En Pedidos, filtros «Entregar hoy» y «Mañana» en la zona horaria del negocio (`GET /api/tenant/settings` devuelve `timezone`).
- **Devoluciones:** `POST /api/orders/:id/returns {items:[{orderItemId,qty}] | amount, reason, resolution, refundMethod}` crea una nota de crédito (`credit_notes`, `NC-0001`, contador `tenants.credit_note_seq`). El importe por artículos lo calcula el servidor (línea proporcional + su parte de descuento e impuesto). Contabilidad: total efectivo = `total_price − credited_total` (Σ notas); cobrado neto `amount_paid` = Σ pagos vigentes − Σ `refunds`; saldo = efectivo − neto. `recalcOrderPayment` lo deriva con SUM en la transacción. Si tras la nota lo cobrado supera el total efectivo, el exceso (hasta el importe de la nota) se resuelve en la MISMA transacción: reembolso con su método o saldo a favor. Con notas no se pueden cambiar artículos, envío ni descuento. **No hay anulación de notas ni de reembolsos**: un error se corrige con una operación nueva. Un pago ya devuelto no se anula.
- **Saldo a favor:** `client_credit_entries` (movimientos con signo; saldo = SUM, nunca negativo; fila del cliente `FOR UPDATE`, siempre después de bloquear el pedido). Método canónico «Saldo a favor» (`CREDIT_METHOD`): pagar con él exige `client_id`, moneda base, ≤ saldo del cliente y ≤ saldo del pedido; anular ese pago devuelve el saldo (`credit_payment_void`). `GET /api/clients/:id/credit` y `credit` en cada ficha. Un cliente con saldo no se puede borrar.
- **Cobrado (informes y Pagos):** pagos − reembolsos, cada uno por su fecha, **excluyendo «Saldo a favor» en ambos lados** (no es dinero nuevo). Los reembolsos salen en Pagos como filas negativas (`kind:'refund'`).
- **Arranque del ciclo:** `ensureOrderCycleSchema` = solo DDL en una transacción corta (advisory lock, `lock_timeout` 5 s, sin DDL si ya existe), 4 reintentos y `process.exit(1)` si falta el esquema. Guarda contra Kisses (misma base): si una de las 4 tablas nuevas existe sin las columnas de CENTRAL, o un índice con nuestro nombre es de otra tabla, no arranca. El CHECK `orders_kind_check` se añade `NOT VALID` (no recorre la tabla); `validateOrdersKindCheck` hace el `VALIDATE` tras `listen` (si falla, se reintenta en el próximo arranque). `BACKGROUND_INDEXES` hoy: `order_items_order_idx`, `orders_tenant_quote_number_uniq`, `orders_tenant_created_idx` (4A: informes, utilidad y por cobrar), `orders_legacy_paid_id_idx` (no hay índice por `delivery_date`: ninguna consulta filtra por él).
- **Límites con devoluciones:** máx. 200 notas de crédito por pedido (`MAX_CREDIT_NOTES_PER_ORDER`, 400). Con notas o saldo a favor en el pedido no se puede cambiar de cliente (`PATCH client_id`, 400); el total efectivo nunca baja de lo cobrado neto (400).
- Eventos de `order_events`: `status_changed`, `cancelled`, `returned`, `refunded`, `converted`.
- Demos: rutas nuevas en la lista blanca (`convert`, `cancel`, `returns`, `GET returns`, `GET clients/:id/credit`); topes `credit_notes` 200, `refunds` 300, `client_credit_entries` 600; el seed trae presupuestos, estados intermedios, un anulado, una devolución con saldo a favor, impuesto apagado y zonas; `wipeDemoData` borra todas las tablas nuevas y reinicia los contadores. El índice único de presupuestos va en `BACKGROUND_INDEXES` (ver «Arranque del ciclo»).

**Dinero y existencias (Fase 4A):** gastos, cierre de caja, costo, existencias por variante y utilidad. Gastos y caja: Pro y Business (el servidor da 403 `plan_required` en `basic`, no solo el menú). Esquema: `ensureStockExpensesSchema` (operacion.js) y `migrations/2026-11-27-gastos-existencias.sql` (debe coincidir con ese DDL). Mismo patrón de arranque que el ciclo del pedido (solo DDL, advisory lock 72616105, `lock_timeout`, comprobar antes de cada DDL, 4 reintentos, `process.exit(1)` si falta algo, guardas contra tablas ajenas de la base compartida con Kisses). Gastos y totales en moneda base; la caja cuenta por método Y moneda. Reglas (no romper):
- **Zona horaria = SOLO la de la ubicación del negocio** (país + zona; `COUNTRY_TIMEZONES` en operacion.js, `tenants.country`/`timezone`), que se fija con `PUT /api/tenant/profile` (`country`, `timezone`; `applyTenantLocation`). El navegador ya no envía `tz`. Países con una zona la reciben sola; «Otro» elige de una lista. Sin zona válida → 400 `{error:'location_required'}` (`requireTz`; el SPA lleva a Ajustes → Ubicación). La zona NO se puede cambiar mientras haya cierres de caja vigentes (400). `backfillTenantTimezones` (server.js) corre en cada arranque y pone la zona por defecto del país donde falta o no es de ese país (`migrations/2026-11-27-zona-horaria.sql`); «Otro» y sin país no se tocan.
- **Gastos** (`expenses`): solo se insertan o se anulan con motivo (`voided_at`/`void_reason`); nunca UPDATE de importes ni DELETE. `spent_on` es el día del negocio (no futuro); moneda extranjera con `exchange_rate` y `amount_base`, igual que los pagos; el método es canónico (`normalizeMethodName`, nunca «Saldo a favor»). La categoría debe estar en `tenant_settings.expense_categories` (NULL = lista por defecto de 7; máx. 30, editables; el nombre no puede llevar comas: `cleanExpenseCategories`); los gastos viejos conservan su categoría aunque se quite de la lista.
- **Cierre de caja** (`cash_closings`): una fila por cierre; reabrir NO borra, marca `reopened_at`/`reopen_reason` y el historial queda (índice único parcial: un solo cierre vigente por día). Esperado **por método y moneda** (clave `método|MONEDA`, con el importe original de cada moneda; los cierres antiguos con clave solo por método se leen como moneda base) = cobros − reembolsos − gastos del día del negocio (sin «Saldo a favor», pagos no anulados). `GET /api/cash/:day` devuelve `rows:[{method,currency,expected,cobrado,reembolsado,gastos[,counted,difference]}]` más `closing`, `history` y `expectedBase` (referencia en moneda base). `POST /close` recibe `counted` como LISTA `[{method,currency,amount}]`, no un objeto. Hay que contar toda fila (método, moneda) con esperado ≠ 0 (400 si falta); no se cierra un día futuro; cerrar un día cerrado → 400. En 4A cualquier sesión puede reabrir; en 4B quedará solo para el dueño.
- **Bloqueo del día cerrado:** con el día cerrado el servidor rechaza (400 «La caja del DD/MM está cerrada») registrar o anular pagos (fecha = `paid_at`), reembolsos de dinero —devoluciones y anulaciones— (fecha = ahora) y gastos (fecha = `spent_on`). El pago/reembolso con «Saldo a favor» no mueve la caja y no se bloquea. Se comprueba DENTRO de la transacción de la operación con `assertCashOpen`. **Orden de bloqueo (siempre):** pedido → tenant (`FOR KEY SHARE` en las operaciones de dinero, `lockTenantForCash`: no choca con el UPDATE de los contadores de pedidos; `FOR UPDATE` al cerrar/reabrir la caja, al cambiar la moneda base y al cambiar país/zona) → cliente (`FOR NO KEY UPDATE`) → existencias (ordenadas por producto y variante). Así «cerrar» y «cobrar» a la vez se serializan (o el cobro entra en lo esperado, o se rechaza).
- **Costo:** `catalog_products.cost` (NULL o ≥ 0). `order_items.unit_cost` es una FOTO del costo al vender (pedido nuevo; presupuesto: al convertirse; al editar líneas se conserva la de las líneas que ya existían): cambiar el costo después no cambia la utilidad vendida. El PATCH de catálogo solo cambia `cost`/`trackStock` si el cuerpo los trae (el resto del PATCH sigue reemplazando).
- **Existencias:** solo productos con `track_stock`. Nivel por (producto, `variant_key`) en `stock_levels` (puede ser negativo: se puede vender sin existencias) + historial `stock_movements` (`sale|cancel|return|edit|adjust_in|adjust_out|count`, con `qty_after`); el nivel se mantiene con upsert en la misma transacción que el movimiento. `variant_key` = `talla|color` en minúsculas y sin acentos (`buildVariantKey`; igual en el SPA, `stockVariantKey`); '' sin variante. El SPA manda `size`/`color` (o `variantKey` al reenviar un pedido guardado) y el servidor deriva la clave; un `productId` ajeno NO se enlaza (queda sin producto, sin costo y sin mover existencias). `syncOrderStock`: crear pedido y convertir presupuesto (`sale`) descuentan lo que piden las líneas; **al editar (`edit`) se aplica SOLO la diferencia** entre líneas viejas y nuevas (un pedido anterior a activar el control no descuenta nada al editarse sin cambiar artículos; lo que se devuelve nunca supera lo ya descontado); anular (`cancel`: vuelve lo que queda sin devolver). Devolución por artículos devuelve las unidades (`return`, sin pasarse de lo descontado); por importe no mueve nada. Un presupuesto nunca descuenta. Ajustes manuales: `delta` (con signo) o `count` (total real) + motivo obligatorio; no se ajusta un producto sin control de existencias. **Las variantes son válidas por producto** (`productVariants`: las tallas × colores que ofrece; otra talla/color → 400; máx. 400 variantes con existencias). **Topes:** ±1 000 000 por ajuste y nivel resultante ≤ 10 000 000 en valor absoluto (400).
- **Utilidad** (`GET /api/reports/profit`, Pro y Business): vendido = Σ(total − notas de crédito); ventas de artículos = por línea precio × (unidades − devueltas) / unidades, SIN envío ni impuesto, con el **descuento del pedido prorrateado** entre sus líneas; una devolución por importe se descuenta primero del envío y el resto (sin impuesto) de las ventas de artículos; un pedido antiguo sin artículos aporta total − envío − impuesto (todo «sin costo»). Costo = Σ `unit_cost` × (unidades − devueltas), solo líneas con costo; utilidad bruta = ventas de artículos − costo (una línea sin costo cuenta como costo 0: `ventasSinCosto` avisa de que está incompleta); neta = bruta − gastos (los gastos no tienen canal: con un canal filtrado no se calculan). **Por cobrar** (`/receivables`): saldo de pedidos no anulados en tramos 0–7, 8–30, 31–60 y >60 días desde `created_at`, y hasta 50 deudores por total (agrupados por ficha, o por nombre si no hay). Top productos (`/api/reports`) descuenta devoluciones por artículos y trae el margen (4.º elemento, null sin costo).
- **Arranque:** `initDB` llama a `ensureStockExpensesSchema` (operacion.js) tras el ciclo; los índices de las 4 tablas nuevas (vacías) van en su DDL y el de `orders` (`orders_tenant_created_idx`) en `BACKGROUND_INDEXES`. `backfillTenantTimezones` también corre en el arranque (ver Zona horaria). No hay relleno de datos: lo anterior queda sin costo, sin control y sin variante.
- **Conexiones:** una transacción nunca pide otra conexión al pool mientras tiene la suya (con tantos pedidos simultáneos como conexiones el servidor se colgaba: `dbCreateOrder` ya lee los artículos con su propia conexión).
- SPA: pantalla Gastos (Pro y Business), tarjeta «Cierre de caja» al inicio de Gastos (Pro y Business, una fila por método y moneda), Ajustes → Ubicación (país y zona), costo y «Controlar existencias» en el producto, ventana «Existencias» (tabla talla × color, ajuste con motivo, historial), aviso «Quedan N / Quedarán N» (rojo si ≤ 0) en el formulario único de pedido y pestaña Informes → Utilidad. `openFormDialog` admite `type:'select'` y `value`.
- **Pedido entregado:** `PATCH /api/orders/:id` rechaza (400) cualquier cambio salvo `delivery_status` (artículos, importes, cliente, notas…); para corregirlo primero se cambia el estado. El SPA lo bloquea igual.
- **Moneda base bloqueada** si ya hay pagos, gastos, reembolsos, cierres de caja o costos (`baseCurrencyInUse`, 400).
- Demos: rutas nuevas en la lista blanca (gastos, caja, existencias, `reports/profit`, `reports/receivables`); topes `expenses` 300, `cash_closings` 60, `stock_levels` 1500 (en `POST /api/stock/adjust`) y `stock_movements` 3000 (también en pedidos, edición, conversión, anulación y devoluciones, que añaden movimientos). El seed trae gastos (uno anulado), un día cerrado con una pequeña diferencia, costos (un producto sin costo a propósito) y existencias por talla × color con una variante en negativo; `wipeDemoData` borra todo lo nuevo.

**Correos de acceso:** siempre en minúsculas (`normEmail`), comparados con `lower(email)`; índice único `tenants_email_lower_uniq`.

## Agentes disponibles

Ver `AGENTES.md` para la guía completa. En CENTRAL se usan **siempre los agentes del proyecto** (`.claude/agents/`, versionados); los globales equivalentes (`backend-node-pg`, `db-migration-helper`, `deploy-checklist`, `revisor-aislamiento`) son para Kisses y otros proyectos. Constructores con Sonnet; revisores y control de despliegue con el modelo más capaz (solo lectura).

**Construcción**
| Cuándo | Agente |
|--------|--------|
| Función nueva que toca backend y SPA | `central-funcionalidad` |
| Rutas, funciones db*, lógica de servidor | `central-backend` |
| Pantallas, modales, conexión del SPA con la API | `central-frontend` |
| Cambio de esquema / relleno de datos | `central-db-schema` |
| WhatsApp, Instagram, Stripe, Resend | `central-integraciones` |
| Escribir y ejecutar pruebas | `central-tester` |
| Poner al día CLAUDE.md, AGENTES.md, `.env.example`, migraciones | `central-docs` |

**Revisión** (en paralelo, antes de desplegar)
| Cuándo | Agente |
|--------|--------|
| Cambia cualquier consulta SQL | `revisor-multitenant` |
| Cambios en backend o SPA (XSS, auth, secretos) | `revisor-seguridad` |
| Cambia una ruta o cómo la usa el SPA | `revisor-contrato-api` |
| Cambian rutas, envíos, facturación, panel admin o `demo-seed.js` | `revisor-demos` |
| Listas, informes, migraciones, webhook | `revisor-escala` |
| Pantalla nueva o rediseño | `revisor-diseno` (global) |
| Revisión general de un diff | `code-reviewer` (global) |
| Algo falla y hay que depurar | `bug-hunter` (global) |
| Justo antes del push | `central-deploy` |

## Skills

**Del proyecto** (`.claude/skills/`, versionadas):
| Skill | Para |
|-------|------|
| `probar-central` | Encender el Postgres local, `npm test`, levantar el servidor local con Meta simulada |
| `revisar-central` | Lanzar en paralelo los revisores que tocan según el diff y unir sus informes |
| `desplegar-central` | Antes del push: veredicto de `central-deploy` y pasos para Carlos. Después: verificación de producción en solo lectura |
| `nueva-funcionalidad` | Función nueva con Carlos: preguntas, plan aprobado, construcción, pruebas, revisión, entrega |

**De la cuenta** (plugins): `engineering:*` (testing-strategy, tech-debt, architecture, debug, incident-response, documentation), `design:*` (design-critique, accessibility-review, ux-copy), `twilio-developer-kit` (WhatsApp/SMS), `cierre` (cerrar una sesión sin pendientes), `frontend-design` (construir pantallas de calidad; complementa a `central-frontend`), `finecomb` (auditoría completa de código y seguridad, solo lectura; complementa a `revisor-seguridad` en auditorías periódicas), `42crunch` (seguridad de API; necesita una especificación OpenAPI que CENTRAL aún no tiene).

## Variables de entorno requeridas (producción)

Ver `backend/.env.example` para la lista completa. Las críticas:
- `DATABASE_URL` — PostgreSQL Railway
- `JWT_SECRET` — clave de firma JWT
- `RESEND_API_KEY` + `RESEND_FROM` — email transaccional
- `WHATSAPP_PHONE_NUMBER_ID` + `WHATSAPP_TOKEN` — WhatsApp Business
- `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` — billing SaaS
- `META_APP_SECRET` — firma del webhook de Meta (sin ella no entran mensajes de WhatsApp/Instagram)
- `WEBHOOK_VERIFY_TOKEN` — verificación del webhook en Meta
