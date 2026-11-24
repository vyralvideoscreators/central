// /app inyecta el plan real del negocio (el menú sale correcto desde el primer instante)
const { ok, reg, db: dbConnect, run } = require('../helpers/harness');
const B = process.env.BASE_URL;

run(async () => {
  const db = await dbConnect();
  const t = await reg('Plan Menu');
  const page = () => fetch(B + '/app?token=' + t.token).then(r => r.text());

  ok(/window\.__TENANT_PLAN__="basic"/.test(await page()), 'Cuenta nueva: plan basic inyectado');
  await db.query(`UPDATE tenants SET plan='pro' WHERE id=$1`, [t.id]);
  ok(/window\.__TENANT_PLAN__="pro"/.test(await page()), 'Al cambiar el plan, /app inyecta el nuevo');
  await db.query(`UPDATE tenants SET plan='<script>' WHERE id=$1`, [t.id]);
  ok(/window\.__TENANT_PLAN__="basic"/.test(await page()), 'Un valor raro en la base no se inyecta tal cual (cae a basic)');
  ok(!/__DEMO_MODE__=true/.test(await page()), 'Una cuenta real no recibe el modo demo');

  await db.query('DELETE FROM tenants WHERE id=$1', [t.id]);
  await db.end();
});
