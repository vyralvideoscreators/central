// Mueve las cuentas demo de la base de producción (railway) a la base de demos (central_demo).
// Conserva correo, clave, caducidad y fecha de creación; siembra los datos de ejemplo actuales.
// Solo borra de producción cuentas con is_demo = true y únicamente después de confirmar la copia.
//
// Uso (desde backend):  railway run --service Postgres node scripts/migrate-demos.js [--apply]
const { Client } = require('pg');
const { seedDemoTenant } = require('../demo-seed');

const ADMIN_URL = process.env.DATABASE_PUBLIC_URL;
if (!ADMIN_URL) { console.log('ERROR: ejecuta con railway run --service Postgres'); process.exit(1); }
const apply = process.argv.includes('--apply');
const ssl = process.env.LOCAL_TEST === '1' ? false : { rejectUnauthorized: false };
const prod = new Client({ connectionString: ADMIN_URL, ssl });
const demo = new Client({ connectionString: ADMIN_URL.replace(/\/railway(\?|$)/, '/central_demo$1'), ssl });

(async () => {
  await prod.connect(); await demo.connect();
  if ((await prod.query('SELECT current_database() d')).rows[0].d !== 'railway') throw new Error('base de producción inesperada');
  if ((await demo.query('SELECT current_database() d')).rows[0].d !== 'central_demo') throw new Error('base de demos inesperada');
  if (!(await demo.query("SELECT to_regclass('public.tenants') t")).rows[0].t) throw new Error('la base de demos aún no tiene tablas (¿se desplegó central-demo?)');

  const { rows: demos } = await prod.query(`
    SELECT t.id, t.business_name, t.full_name, t.email, t.password_hash, t.country, t.demo_days, t.expires_at, t.created_at, t.active,
      (SELECT city FROM clients c WHERE c.tenant_id = t.id AND city IS NOT NULL LIMIT 1) AS city
    FROM tenants t WHERE t.is_demo = true ORDER BY t.created_at`);
  const { rows: [{ n: realCount }] } = await prod.query('SELECT count(*)::int n FROM tenants WHERE is_demo IS NOT TRUE');
  console.log(`Producción: ${demos.length} demo(s) [${demos.map(d => d.business_name).join(', ')}] y ${realCount} cuenta(s) real(es) que NO se tocan.`);
  if (!apply) { console.log('Simulación: añade --apply para ejecutar.'); return; }

  for (const d of demos) {
    await demo.query('BEGIN');
    try {
      await demo.query(`INSERT INTO tenants (id, business_name, full_name, email, password_hash, plan, country, is_demo, demo_days, expires_at, created_at, active)
        VALUES ($1,$2,$3,$4,$5,'business',$6,true,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [d.id, d.business_name, d.full_name, d.email, d.password_hash, d.country, d.demo_days, d.expires_at, d.created_at, d.active]);
      const hasData = (await demo.query('SELECT 1 FROM clients WHERE tenant_id = $1 LIMIT 1', [d.id])).rowCount;
      if (!hasData) await seedDemoTenant(demo, d.id, { city: d.city || undefined });
      await demo.query('COMMIT');
    } catch (e) { await demo.query('ROLLBACK'); throw e; }

    const copy = (await demo.query('SELECT email, password_hash, expires_at FROM tenants WHERE id = $1 AND is_demo = true', [d.id])).rows[0];
    const copied = copy && copy.email === d.email && copy.password_hash === d.password_hash && +new Date(copy.expires_at) === +new Date(d.expires_at);
    if (!copied) throw new Error(`la copia de ${d.business_name} no coincide; no se borra de producción`);

    const del = await prod.query('DELETE FROM tenants WHERE id = $1 AND is_demo = true', [d.id]);
    console.log(`OK ${d.business_name}: copiada a central_demo (misma clave y caducidad) y ${del.rowCount ? 'borrada' : 'NO encontrada'} en producción`);
  }
  const { rows: [{ n: realAfter }] } = await prod.query('SELECT count(*)::int n FROM tenants WHERE is_demo IS NOT TRUE');
  console.log(`Cuentas reales en producción: antes ${realCount}, después ${realAfter}${realAfter === realCount ? ' (sin cambios)' : ' ¡REVISAR!'}`);
})().catch(e => { console.log('ERROR:', e.message); process.exitCode = 1; })
  .finally(async () => { await prod.end().catch(() => {}); await demo.end().catch(() => {}); });
