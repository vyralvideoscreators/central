// Un reinicio del servidor NO debe numerar los presupuestos como pedidos (migración "Numeración de pedidos"
// de initDB) ni hacer saltar la numeración del siguiente pedido.
const path = require('path');
const { spawn } = require('child_process');
const { ok, send, reg, db, run } = require('../helpers/harness');

const ROOT = path.join(__dirname, '..', '..');
const PORT2 = Number(process.env.PORT || 3990) + 7;

async function startSecondServer() {
  const env = { ...process.env, PORT: String(PORT2), APP_URL: `http://localhost:${PORT2}` };
  const mock = path.join(ROOT, 'test', 'helpers', 'mock-meta.js');
  const p = spawn(process.execPath, ['--require', mock, 'server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  for (let i = 0; i < 100; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const h = await fetch(`http://127.0.0.1:${PORT2}/health`).then(r => r.json());
      if (h && h.db) return { p, log: () => log };
    } catch {}
    if (p.exitCode !== null) break;
  }
  p.kill();
  throw new Error('El segundo servidor no arrancó:\n' + log);
}

const item = { name: 'Taza', qty: 1, unitPrice: 10, linePrice: 10 };

run(async () => {
  const t = await reg('Reinicio Presupuestos');
  const o1 = await send(t.H, 'POST', '/api/orders', { clientName: 'Ana', items: [item] });
  ok(o1.status === 200 || o1.status === 201, 'pedido 1 creado');
  const q1 = await send(t.H, 'POST', '/api/orders', { clientName: 'Ana', kind: 'quote', items: [item] });
  const q2 = await send(t.H, 'POST', '/api/orders', { clientName: 'Luis', kind: 'quote', items: [item] });
  ok((q1.status === 200 || q1.status === 201) && (q2.status === 200 || q2.status === 201), 'dos presupuestos creados');

  // Reinicio: otro proceso del servidor sobre la MISMA base ejecuta initDB de nuevo
  const s = await startSecondServer();
  s.p.kill();
  await new Promise(r => setTimeout(r, 300));

  const c = await db();
  try {
    const { rows: qs } = await c.query(
      `SELECT tenant_order_number FROM orders WHERE tenant_id = $1 AND kind = 'quote'`, [t.id]);
    ok(qs.length === 2 && qs.every(r => r.tenant_order_number === null), 'tras el reinicio los presupuestos siguen sin número de pedido');
    const { rows: [tn] } = await c.query(`SELECT order_seq FROM tenants WHERE id = $1`, [t.id]);
    ok(Number(tn.order_seq) === 1, 'el contador de pedidos no avanzó por los presupuestos (order_seq = ' + tn.order_seq + ')');
  } finally { await c.end(); }

  const o2 = await send(t.H, 'POST', '/api/orders', { clientName: 'Ana', items: [item] });
  ok(o2.body && Number(String(o2.body.orderNumber).replace(/\D/g, '')) === 2, 'el siguiente pedido es el #0002, sin saltos (' + (o2.body && o2.body.orderNumber) + ')');
});
