// Fase 4B (corrección) — cola de informes: una petición cancelada mientras espera no ocupa ni pierde un hueco, la cola tiene tope
// (503 busy con Retry-After) y el siguiente informe siempre responde.
const { ok, run } = require('../helpers/harness');
const { setPlan, reg, db } = require('../helpers/equipo');

run(async () => {
  const c = await db();
  const O = await reg('Cola informes');
  await setPlan(c, O.id, 'pro');
  const url = process.env.BASE_URL + '/api/reports?period=mes';
  const get = (signal) => fetch(url, { headers: O.H, signal }).then(r => ({ status: r.status, retry: r.headers.get('retry-after') })).catch(e => ({ aborted: e.name === 'AbortError' }));

  // 40 peticiones a la vez: 2 corren, hasta 20 esperan, el resto recibe 503 busy. Se cancelan 14 mientras están en cola.
  const ctrls = Array.from({ length: 40 }, () => new AbortController());
  const all = ctrls.map((ct) => get(ct.signal));
  await new Promise(r => setTimeout(r, 15));
  for (let i = 3; i < 17; i++) ctrls[i].abort();
  const res = await Promise.all(all);
  ok(res.every(r => r.aborted || r.status === 200 || r.status === 503), 'Todas terminan en 200, 503 o canceladas (sin 500 ni colgadas)');
  ok(res.filter(r => r.status === 503).every(r => r.retry), 'Todo 503 lleva Retry-After');
  console.log('INFO ' + res.filter(r => r.status === 200).length + ' en 200, ' + res.filter(r => r.status === 503).length + ' en 503, ' + res.filter(r => r.aborted).length + ' canceladas');

  // Si los huecos se hubieran perdido, el siguiente informe se quedaría esperando para siempre
  const t0 = Date.now();
  const next = await Promise.race([get(), new Promise(r => setTimeout(() => r({ timeout: true }), 8000))]);
  ok(next.status === 200, 'El informe siguiente responde (200) tras las cancelaciones, en ' + (Date.now() - t0) + ' ms');
  // Dos rondas más: los huecos siguen sanos
  const again = await Promise.all(Array.from({ length: 4 }, () => get()));
  ok(again.every(r => r.status === 200), 'Y cuatro a la vez (1 en curso + 3 en cola del negocio) tambien');

  // Tope por negocio: 1 en curso y 3 en cola; el resto 503 busy aunque la cola global este casi vacia
  const burst = await Promise.all(Array.from({ length: 8 }, () => get()));
  ok(burst.filter(r => r.status === 503).length >= 4 && burst.every(r => r.status === 200 || r.status === 503), 'Un negocio con 8 a la vez: al menos 4 reciben 503 busy por su tope propio');
  // Otro negocio sigue teniendo hueco mientras el primero esta saturado
  const P = await reg('Cola informes B');
  await setPlan(c, P.id, 'pro');
  const getP = () => fetch(url, { headers: P.H }).then(r => r.status);
  const [mix] = await Promise.all([getP(), ...Array.from({ length: 8 }, () => get())]);
  ok(mix === 200, 'Otro negocio no queda bloqueado por la saturacion del primero');
  await new Promise(r => setTimeout(r, 300));
  ok((await get()).status === 200, 'Y los contadores se liberan (el siguiente informe responde)');

  await c.end();
});
