// Meta simulada para las pruebas: se carga con `node --require` ANTES de server.js.
// Ninguna llamada a graph.facebook.com / graph.instagram.com sale a internet:
// se registran (una línea JSON por llamada) en el archivo META_LOG y se responde como Meta.
const fs = require('fs');
const axios = require('axios');

const LOG = process.env.META_LOG;
const isMeta = (u) => /graph\.(facebook|instagram)\.com/.test(String(u));
const log = (entry) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...entry }) + '\n'); };

const realPost = axios.post.bind(axios);
const realGet = axios.get.bind(axios);

axios.post = async (url, data, cfg) => {
  if (!isMeta(url)) return realPost(url, data, cfg);
  log({ method: 'POST', url, body: (data && typeof data.getHeaders === 'function') ? '[multipart]' : data });
  if (/\/media$/.test(url)) return { data: { id: 'mock_media_' + Date.now() } };
  if (/graph\.instagram\.com/.test(url)) return { data: { message_id: 'mock_ig_' + Date.now() } };
  return { data: { messages: [{ id: 'mock_wa_' + Date.now() }] } };
};

axios.get = async (url, cfg) => {
  if (!isMeta(url)) return realGet(url, cfg);
  log({ method: 'GET', url });
  throw new Error('Meta simulada: GET no disponible');
};
