import axios from 'axios';
import { env } from '../config/env.js';

// Base das chamadas da Z-API: https://api.z-api.io/instances/{id}/token/{token}/...
const base = () =>
  `https://api.z-api.io/instances/${env.zapi.instanceId}/token/${env.zapi.token}`;

const headers = () => ({
  'Content-Type': 'application/json',
  'Client-Token': env.zapi.clientToken,
});

async function post(path, body) {
  try {
    const { data } = await axios.post(`${base()}${path}`, body, { headers: headers() });
    return data;
  } catch (err) {
    console.error('[zapi] erro:', path, err.response?.data || err.message);
    throw err;
  }
}

async function get(path) {
  try {
    const { data } = await axios.get(`${base()}${path}`, { headers: headers() });
    return data;
  } catch (err) {
    console.error('[zapi] erro GET:', path, err.response?.data || err.message);
    throw err;
  }
}

export const zapi = {
  // Envia texto simples
  sendText(phone, message) {
    return post('/send-text', { phone, message });
  },
  // Envia imagem (url pública) com legenda
  sendImage(phone, imageUrl, caption = '') {
    return post('/send-image', { phone, image: imageUrl, caption });
  },
  // Envia vídeo
  sendVideo(phone, videoUrl, caption = '') {
    return post('/send-video', { phone, video: videoUrl, caption });
  },
  // Envia documento (ex.: contrato em PDF)
  sendDocument(phone, docUrl, fileName) {
    return post(`/send-document/pdf`, { phone, document: docUrl, fileName });
  },
  // Verifica se o número tem WhatsApp e retorna o LID associado
  // ({ exists, phone, lid }). LID->telefone não existe (privacidade);
  // telefone->LID é o único caminho — usado para mapear proativamente.
  phoneExists(phone) {
    return get(`/phone-exists/${phone}`);
  },
};
