# Agentes de Claude Code — guía de uso

Referencia rápida de los subagentes disponibles: qué hay, cuándo usar cada uno y
cómo llamarlos. Los agentes son archivos `.md` en `~/.claude/agents/` (globales,
para todos los repos) o en `<repo>/.claude/agents/` (solo ese repo; el de repo
gana si hay dos con el mismo nombre).

## Cómo ver la lista de agentes

- **Preguntarle a Claude** (lo más simple en el desktop): *"¿qué agentes tengo?"*
- **Gestor integrado** (terminal `claude` interactiva): el comando `/agents` abre
  un panel para listar, crear, editar y borrar agentes.
- **Desde los archivos** (comando reutilizable, imprime nombre + descripción de los
  globales y los del repo actual):

```bash
for d in ~/.claude/agents ./.claude/agents; do [ -d "$d" ] && for f in "$d"/*.md; do awk '/^name:/{n=$0;sub(/name: */,"",n)} /^description:/{d=$0;sub(/description: */,"",d)} END{printf "• %-22s %s\n", n, d}' "$f"; done; done
```

## Cuándo usar cada uno

| Situación | Agente |
|-----------|--------|
| Voy a commitear/subir y quiero que revisen el diff | `code-reviewer` |
| Toqué queries de Kisses (aislamiento por `business_id`) | `revisor-aislamiento` |
| Toqué cobros/saldos/depósitos (Motor 4) | `revisor-dinero` |
| Hice o cambié una pantalla/UI | `revisor-diseno` |
| Voy a escribir un endpoint o lógica de backend | `backend-node-pg` |
| Algo falla / dato que no cuadra / bug raro | `bug-hunter` |
| Necesito cambiar el esquema de la BD (tabla/columna/índice) con datos reales | `db-migration-helper` |
| Estoy por desplegar a producción | `deploy-checklist` |
| Sitio web para un cliente de Magic Design | `client-site-builder` |

## Los 9 agentes (globales)

**Genéricos (todos los proyectos):**

- **code-reviewer** — Usar SIEMPRE antes de hacer commit o push, o cuando se pida
  "revisa mis cambios", "revisa este diff", "revisa el código antes de subirlo".
- **backend-node-pg** — Escribir o modificar backend en Node.js/Express con
  PostgreSQL: nuevos endpoints, lógica de negocio, integraciones (WhatsApp/Instagram
  API, etc.), consultas SQL.
- **db-migration-helper** — Cambiar el esquema de la base de datos (nueva tabla,
  columna, índice, cambio de tipo) en un proyecto con datos reales en producción.
- **bug-hunter** — Cuando algo no funciona como se espera y hay que depurar: un
  error, un comportamiento raro, un endpoint que falla, un dato que no cuadra.
- **deploy-checklist** — Antes de desplegar a producción, o "voy a subir esto",
  "vamos a desplegar", "prepárame para el deploy".
- **client-site-builder** — Páginas web para clientes de Magic Design LLC: sitios
  nuevos, ajustes de sitios existentes, cotización de alcance.

**Específicos de Kisses and Paws (solo lectura, reportan hallazgos):**

- **revisor-aislamiento** — Verifica que toda consulta SQL nueva o modificada filtre
  por `business_id`, incluyendo subconsultas y JOINs.
- **revisor-dinero** — Revisa cambios que tocan cálculo de dinero: `montoAhora`,
  saldo, estado, depósitos, descuentos, tickets, `kp_billing_records`, `kp_payments`.
- **revisor-diseno** — Aplica el checklist de calidad de interfaz (paleta cerrada,
  evitar clichés de IA genérica, aprovechamiento de espacio, usabilidad).

## Cómo invocarlos

- **Automático:** Claude los activa solo según la tarea y la `description` del agente.
- **Explícito:** *"usa el agente bug-hunter para este error"*.
- **Si dos aplican** (ej. un cambio en Motor 4 encaja con `code-reviewer` genérico y
  con `revisor-dinero` específico), invoca el específico por nombre: trae tus reglas
  reales (`kp_billing_records`, `kp_payments`, etc.).

## Añadir reglas propias de un repo

Para reglas específicas de un proyecto, crea `<repo>/.claude/agents/nombre.md`. Si
coincide el nombre con uno global, el de repo gana. Puedes pedirle a Claude que te
genere uno: *"créame un agente para X con estas reglas…"*.
