---
name: central-frontend
description: Modificar el frontend SPA de CENTRAL (backend/central-mvp-v63 (1) - copia.html) — nuevas pantallas, componentes, conexión de módulos al backend, correcciones de UI. Conoce el patrón loadReal/fallback, los módulos y las convenciones del archivo.
---

# Agente frontend — CENTRAL

## Contexto

- **Archivo único**: `backend/central-mvp-v63 (1) - copia.html` (la copia de la raíz es antigua y NO se despliega) (~600 KB, sin build, vanilla JS/CSS)
- **Estructura**: HTML + `<style>` + `<script>` todo inline
- **Auth**: JWT en `localStorage` key `central_jwt`; se valida en `verifySessionAndApplyTenant()` al cargar
- **Backend URL**: constante `BACKEND_URL` (definida cerca del inicio del script)

## Patrón de conexión al backend

Todos los módulos siguen el mismo patrón:

```js
async function loadRealX() {
  try {
    const res = await fetch(BACKEND_URL + '/api/ruta', { headers: apiAuthHeader() });
    if (!res.ok) throw new Error('Backend respondió ' + res.status);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return false;
    // mapear snake_case → camelCase y formato frontend
    xDB = data.map(item => ({ ...mapeo... , _backendId: item.id }));
    return true;
  } catch (err) { return false; }
}
```

Helpers de auth ya disponibles:
- `apiAuthHeader()` → `{ Authorization: 'Bearer <jwt>' }`
- `apiHeaders()` → `{ 'Content-Type': 'application/json', Authorization: ... }`

## Módulos y variables globales

| Módulo | Variable | Loader | Re-render |
|--------|----------|--------|-----------|
| Conversaciones | `convos` | `loadRealConversations()` | `renderConversationList()` |
| Pedidos | `orders` | `loadRealOrders()` | `renderOrders()` |
| Catálogo | `catalog` | `loadRealCatalog()` | `renderCatalog()` |
| Clientes | `clientsDB` | `loadRealClients()` | `renderClients()` |
| Informes | `getInfData(period)` | (calculado desde `orders`) | `renderInforme(tab)` |

## Startup

```js
Promise.all([
  loadRealConversations(),
  loadRealCatalog(),
  loadRealClients(),
  loadRealOrders(),
]).then(() => { loadChat(firstKey); showConvoHistory(firstKey); });
```

Si agregas un nuevo loader, incorpóralo al `Promise.all`.

## Convenciones de UI

- **Toasts**: `showToast('mensaje ✓')` para feedback de acciones
- **Modales**: `closeModal()` para cerrar el modal principal
- **Vistas**: `goView('nombre')` para navegar; cada vista tiene `id="v-nombre"`
- **Colores CSS**: usar variables (`var(--accent)`, `var(--green)`, `var(--red)`, `var(--wa)`, `var(--ig)`)
- **Tipografía**: `font-family: 'Syne', sans-serif` para títulos en bold
- Layout: seguir los patrones existentes — indicadores en fila horizontal, mismos tamaños

## IDs del backend

Los objetos del frontend almacenan `_backendId` cuando vienen del backend. Para PATCH/DELETE:
```js
const backendId = obj._backendId || obj.id;
await fetch(`${BACKEND_URL}/api/ruta/${backendId}`, { method: 'PATCH', ... });
```

## Mapeo de campos (backend → frontend)

| Backend (snake_case) | Frontend (camelCase) |
|---------------------|---------------------|
| `pay_status` | `pay` ('ok'/'pend') |
| `delivery_status` | `delivery` ('to_deliver'/'delivered'/'not_delivered') |
| `client_name` | `client` |
| `product_summary` | `product` |
| `total_price` | `price` (con '$' prefix) |
| `pay_method` | `pay` en clientes |
| `extra_addresses` | `extraAddresses` |
| `is_vip` | `isVip` |

## Checklist antes de entregar código

- [ ] La función `loadReal*` tiene try/catch y retorna `false` en caso de error
- [ ] Los objetos cargados del backend tienen `_backendId`
- [ ] Las operaciones PATCH/DELETE usan `_backendId` si está disponible
- [ ] El nuevo loader se añadió al `Promise.all` del startup si es un módulo principal
- [ ] Los toasts confirman acciones exitosas
- [ ] El fallback a datos demo funciona si el backend no está disponible
