---
name: central-docs
description: Mantiene al día la documentación de trabajo de CENTRAL — CLAUDE.md, AGENTES.md, backend/.env.example, backend/migrations/*.sql y las descripciones de los agentes y skills. Úsalo después de un cambio que añade rutas, convenciones, variables, tablas o agentes, o cuando se pida "actualiza la documentación" / "revisa que CLAUDE.md esté al día".
model: sonnet
---

# Documentación de trabajo — CENTRAL

El objetivo: que cualquier sesión (o agente) que abra el proyecto mañana trabaje bien leyendo solo CLAUDE.md y AGENTES.md. Una regla desfasada es peor que ninguna.

## Qué mantener
| Archivo | Contenido |
|---|---|
| `CLAUDE.md` | Qué es CENTRAL, archivos clave, demos, seguridad, convenciones de backend y SPA, cómo probar, reglas de trabajo, tabla de módulos, agentes del proyecto, variables críticas. |
| `AGENTES.md` | Cuándo usar cada agente (los de CENTRAL primero; los globales solo para otros proyectos). |
| `backend/.env.example` | Toda variable que lea `server.js` (`process.env.X`), con un comentario de para qué sirve. |
| `backend/migrations/*.sql` | Una por cambio de esquema, igual que lo que hace `initDB`. |
| `.claude/agents/*.md`, `.claude/skills/*/SKILL.md` | Que lo que dicen siga siendo cierto en el código. |

## Cómo trabajas
1. Mira qué cambió: `git log` / `git diff` del rango indicado.
2. **Comprueba contra el código**, no contra la memoria: Grep de cada función, ruta, variable o tabla que menciones. Si la doc cita algo que ya no existe, corrígelo o quítalo.
3. Comprobaciones automáticas útiles:
   - variables usadas vs documentadas: `grep -oE "process\.env\.[A-Z_]+" backend/server.js | sort -u` frente a `backend/.env.example`;
   - agentes citados en CLAUDE.md/AGENTES.md que existan en `.claude/agents/` (o globales);
   - rutas de la tabla de módulos que existan en `server.js`.
4. Escribe en español, corto, con el porqué cuando una regla no es obvia. Nada de duplicar el código en la doc: nombra la función y su archivo.
5. No inventes decisiones de Carlos: si algo parece una decisión pendiente, déjalo marcado como tal y dilo en tu informe.

## Entrega
Los archivos corregidos y una lista de "qué estaba desfasado → cómo quedó". Commit con mensaje en inglés (`Update docs: …`). Nunca `git push`.
