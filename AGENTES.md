# Agentes de Claude Code — guía de uso

Referencia rápida de los subagentes: qué hay, cuándo usar cada uno y cómo llamarlos.
Los agentes son archivos `.md` en `<repo>/.claude/agents/` (solo este repo, **versionados
en git**) o en `~/.claude/agents/` (globales, para todos los proyectos). Si hay dos con el
mismo nombre, gana el del repo.

**Regla en CENTRAL:** usar siempre los agentes del proyecto. Los globales equivalentes
(`backend-node-pg`, `db-migration-helper`, `deploy-checklist`, `revisor-aislamiento`) son
para Kisses and Paws y otros proyectos.

## El equipo de CENTRAL (13 agentes en `.claude/agents/`)

### Construcción (modelo Sonnet; escriben código y lo entregan con pruebas)

| Agente | Úsalo para |
|--------|------------|
| `central-funcionalidad` | Una función completa de punta a punta (esquema → API → SPA → pruebas → docs). Entrega primero un plan si el encargo es grande. |
| `central-backend` | Rutas API, funciones `db*`, validación, transacciones, WebSocket en `backend/server.js`. |
| `central-frontend` | Pantallas, modales y conexión del SPA con la API; criterio de diseño de Carlos. |
| `central-db-schema` | Cambios de esquema y rellenos de datos con datos reales (idempotentes, una sola vez, con respaldo). |
| `central-integraciones` | WhatsApp/Instagram (Meta), Stripe y Resend: construir o depurar. |
| `central-tester` | Escribir pruebas e2e en `backend/test/e2e` y ejecutar `npm test`. |
| `central-docs` | Poner al día CLAUDE.md, AGENTES.md, `.env.example`, `migrations/` y las descripciones de agentes/skills. |

### Revisión (modelo más capaz; solo lectura, reportan hallazgos con gravedad)

| Agente | Revisa |
|--------|--------|
| `revisor-multitenant` | Que toda consulta filtre por `tenant_id` y ningún id del navegador toque datos de otro negocio. **Siempre que cambie SQL.** |
| `revisor-seguridad` | XSS en el SPA, rutas sin auth, tokens, secretos, inyección, SSRF en tickets, webhooks. |
| `revisor-contrato-api` | Que SPA y backend hablen igual (campos, tipos, respuestas) y que ningún error falle en silencio. |
| `revisor-demos` | Que las demos no salgan a Meta/Stripe/Resend, no se mezclen con lo real y "Hacer real" las deje vacías. |
| `revisor-escala` | Lo que no aguantará el crecimiento: índices, N+1, cargas completas, memoria, arranque. |
| `central-deploy` | Puerta final antes del push: pruebas, migraciones, variables, veredicto y pasos para Carlos. |

### Globales que CENTRAL también usa
`revisor-diseno` (pantallas nuevas), `code-reviewer` (revisión general de un diff), `bug-hunter` (depurar).

## Flujo de un cambio en CENTRAL

```
construir (central-*)  →  npm test  →  revisores en paralelo  →  corregir y volver a probar
   →  central-docs  →  central-deploy (veredicto)  →  Carlos hace git push
```

Qué revisores lanzar según lo que cambió:
- SQL → `revisor-multitenant`
- Backend o SPA → `revisor-seguridad`
- Una ruta o su uso en el SPA → `revisor-contrato-api`
- Rutas, envíos, facturación, panel admin, `demo-seed.js` → `revisor-demos`
- Listas, informes, migraciones, webhook → `revisor-escala`
- Pantalla nueva → `revisor-diseno`

Se lanzan **a la vez** (en una sola petición: *"pasa revisor-multitenant, revisor-seguridad y
revisor-contrato-api sobre el diff"*), y sus informes usan el mismo formato
(`[GRAVEDAD] archivo:línea — problema — escenario — arreglo`) para poder juntarlos.

## Otros proyectos (agentes globales en `~/.claude/agents/`)

| Situación | Agente |
|-----------|--------|
| Revisar un diff antes de commit/push | `code-reviewer` |
| Queries de Kisses (aislamiento por `business_id`) | `revisor-aislamiento` |
| Cobros/saldos/depósitos de Kisses (Motor 4) | `revisor-dinero` |
| Pantalla/UI nueva o cambiada | `revisor-diseno` |
| Endpoint o lógica de backend | `backend-node-pg` |
| Algo falla / dato que no cuadra | `bug-hunter` |
| Cambio de esquema con datos reales | `db-migration-helper` |
| Antes de desplegar | `deploy-checklist` |
| Sitio web para un cliente de Magic Design | `client-site-builder` |

## Cómo ver la lista de agentes

- **Preguntarle a Claude**: *"¿qué agentes tengo?"*
- **Gestor integrado** (terminal `claude`): `/agents` lista, crea, edita y borra.
- **Desde los archivos** (nombre + descripción de los globales y los del repo actual):

```bash
for d in ~/.claude/agents ./.claude/agents; do [ -d "$d" ] && for f in "$d"/*.md; do awk '/^name:/{n=$0;sub(/name: */,"",n)} /^description:/{d=$0;sub(/description: */,"",d)} END{printf "• %-24s %s\n", n, substr(d,1,110)}' "$f"; done; done
```

## Cómo invocarlos

- **Automático:** Claude los elige según la tarea y la `description` del agente.
- **Explícito:** *"usa central-tester para cubrir este cambio"*.
- **Si dos aplican**, invoca el específico por nombre (trae las reglas reales del proyecto).

## Añadir o cambiar un agente

Crea o edita `.claude/agents/nombre.md` (frontmatter `name`, `description`, opcional
`tools` y `model`). Los revisores llevan `tools: Read, Grep, Glob, Bash` (solo lectura).
Después, que `central-docs` actualice esta guía y la tabla de CLAUDE.md, y haz commit:
los agentes son parte del protocolo de trabajo y viajan con el repo.
