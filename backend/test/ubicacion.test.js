// Unitaria (sin base de datos): país → zonas horarias de la ubicación del negocio
const ops = require('../operacion');
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const valid = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

ok(ops.COUNTRIES.length === 21 && ops.COUNTRIES.includes('Otro') && ops.COUNTRIES.includes('República Dominicana'), 'Lista cerrada de 21 países (20 + Otro)');
ok(Object.values(ops.COUNTRY_TIMEZONES).flat().every(valid), 'Todas las zonas de los países son IANA válidas');
ok(ops.timezonesForCountry('Otro').length > 40 && ops.timezonesForCountry('Otro').every(valid), '«Otro»: lista amplia de zonas válidas');
ok(ops.COUNTRY_TIMEZONES['México'].length === 6 && ops.COUNTRY_TIMEZONES['México'][0] === 'America/Mexico_City', 'México: 6 zonas, la primera por defecto');
ok(ops.COUNTRY_TIMEZONES['Chile'].join() === 'America/Santiago,Pacific/Easter' && ops.COUNTRY_TIMEZONES['Ecuador'].join() === 'America/Guayaquil,Pacific/Galapagos'
  && ops.COUNTRY_TIMEZONES['España'].join() === 'Europe/Madrid,Atlantic/Canary', 'Chile, Ecuador y España: 2 zonas');
ok(ops.canonCountry('mexico') === 'México' && ops.canonCountry(' REPUBLICA dominicana ') === 'República Dominicana' && ops.canonCountry('Panamá') === 'Panama' && ops.canonCountry('VE') === null && ops.canonCountry(null) === null,
  'canonCountry: sin distinguir mayúsculas ni acentos; lo desconocido es null');
ok(ops.defaultTimezoneFor('Venezuela') === 'America/Caracas' && ops.defaultTimezoneFor('Otro') === null && ops.defaultTimezoneFor(null) === null, 'Zona por defecto: la primera; «Otro» y sin país, ninguna');
// Zona efectiva
ok(ops.tzOf({ country: 'Venezuela', timezone: null }) === 'America/Caracas', 'Falta la zona → la del país');
ok(ops.tzOf({ country: 'Venezuela', timezone: 'Asia/Tokyo' }) === 'America/Caracas', 'Zona de otro país → se recalcula desde el país');
ok(ops.tzOf({ country: 'México', timezone: 'America/Cancun' }) === 'America/Cancun', 'Zona del país con varias → se respeta');
ok(ops.tzOf({ country: 'Otro', timezone: null }) === null && ops.tzOf({ country: 'Otro', timezone: 'America/New_York' }) === 'America/New_York' && ops.tzOf({ country: 'Otro', timezone: 'Asia/Tokyo' }) === null, '«Otro»: solo la elegida de su lista');
ok(ops.tzOf({ country: null, timezone: null }) === null && ops.tzOf({ country: null, timezone: 'America/Lima' }) === 'America/Lima' && ops.tzOf({ country: 'VE', timezone: 'Nada/Mala' }) === null, 'Sin país: la guardada si es válida (negocios antiguos), si no ninguna');
let threw = false; try { ops.requireTz({ country: 'Otro' }); } catch (e) { threw = e instanceof ops.LocationRequired && e instanceof ops.BadRequest && /Ajustes → Perfil → País y zona horaria/.test(e.message); }
ok(threw, 'requireTz sin zona lanza LocationRequired (un BadRequest con el mensaje de ubicación)');

console.log(fails ? `\n${fails} FALLO(S)` : '\nTODO OK');
process.exit(fails ? 1 : 0);
