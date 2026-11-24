---
name: nueva-funcionalidad
description: Guía con Carlos el desarrollo de una funcionalidad nueva de CENTRAL de principio a fin — preguntas de negocio, plan para que lo apruebe, construcción con los agentes del proyecto, pruebas, revisión y preparación del despliegue. Úsala cuando Carlos pida algo nuevo para la app ("quiero que CENTRAL haga X", "añade Y", "nueva pantalla para Z") que no sea un arreglo pequeño.
---

# Nueva funcionalidad de CENTRAL (con Carlos)

Carlos quiere participar en las decisiones. Esta skill le consulta en los puntos que son suyos y avanza sola en lo técnico.

## 1. Entender (preguntar solo lo que cambia el resultado)
Antes de preguntar, lee `CLAUDE.md` y el código relacionado: no preguntes lo que el código ya responde. Después, con **una sola tanda** de preguntas (AskUserQuestion, opciones concretas, la recomendada primero), aclara lo que sea suyo:
- qué problema del negocio resuelve y para quién (dueño del negocio, su cliente final, el panel admin);
- en qué planes va (basic / pro / business) y si las demos la tienen;
- comportamiento en los casos dudosos (qué pasa si…);
- si implica un servicio externo o coste (Meta, Stripe, Resend…): eso requiere su confirmación.

## 2. Plan para aprobar
Presenta un plan corto en lenguaje de negocio + lo técnico justo:
- qué verá el usuario (pantallas, botones, avisos);
- cambios de datos (tablas/columnas; si hay relleno de datos existentes);
- rutas de la API;
- pruebas que se añadirán;
- riesgos y lo que no se hará.
**Espera su aprobación** o ajustes antes de construir.

## 3. Construir
- Funcionalidad que cruza backend y SPA → agente `central-funcionalidad` con el plan aprobado. O por partes: `central-db-schema` → `central-backend` (+ `central-integraciones` si hay servicio externo) → `central-frontend`, y `central-tester` para las pruebas.
- Commits por grupo lógico (inglés, imperativo, ≤72 caracteres).
- Si aparece una decisión de negocio no prevista, **pregunta a Carlos** en vez de suponer.

## 4. Probar y revisar
- Skill `probar-central`: `npm test` en verde y prueba manual en el navegador si hay pantalla (enseñar una captura a Carlos).
- Skill `revisar-central`: revisores en paralelo; corregir lo que encuentren y volver a probar.
- `central-docs`: CLAUDE.md, AGENTES.md, `.env.example`, `migrations/`.

## 5. Entregar
Resumen para Carlos: qué hace la función (cómo usarla), commits, pruebas, lo que no se pudo probar, y los pasos de despliegue (skill `desplegar-central`, parte A). El push lo hace él.
