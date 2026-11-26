// Fase 4B — informes: ráfaga de informes a la vez (el semáforo de 2 por réplica pone en cola, nunca da 500) y cifras iguales.
const { ok, run } = require('../helpers/harness');
const { setPlan, j, send, reg, db } = require('../helpers/equipo');

run(async () => {
  const c = await db();
  const O = await reg('Informes Cola');
  await setPlan(c, O.id, 'business');
  await send(O.H, 'POST', '/api/orders', { clientName: 'A', items: [{ name: 'X', qty: 2, unitPrice: 10 }], initialPayment: { amount: 5, method: 'Efectivo' } });
  await send(O.H, 'POST', '/api/expenses', { amount: 3, category: 'Otros', method: 'Efectivo' });
  const base = await j('/api/reports?period=mes', { headers: O.H });
  const profit = await j('/api/reports/profit?period=mes', { headers: O.H });
  ok(base.status === 200 && base.body.ventas === 20 && base.body.cobrado === 5 && base.body.pedidos === 1, 'Informe: ventas 20, cobrado 5, 1 pedido');
  ok(profit.status === 200 && profit.body.vendido === 20 && profit.body.gastos === 3 && profit.body.devuelto === 0 && profit.body.baseCurrency === 'USD', 'Utilidad: vendido 20, gastos 3, moneda USD');
  const calls = [];
  for (let k = 0; k < 7; k++) calls.push(j('/api/reports?period=mes', { headers: O.H }), j('/api/reports/profit?period=mes', { headers: O.H }), j('/api/reports/receivables', { headers: O.H }));
  const res = await Promise.all(calls);
  ok(res.every(r => r.status === 200), '21 informes a la vez (caben en las 2 plazas + cola de 20): todos 200');
  ok(res.filter((r, i) => i % 3 === 0).every(r => JSON.stringify(r.body) === JSON.stringify(base.body)), 'Las cifras del informe son idénticas bajo carga');
  const h = await j('/health');
  ok(h.status === 200 && h.body.db === true, 'El servidor sigue sano tras la ráfaga');
  await c.end();
});
