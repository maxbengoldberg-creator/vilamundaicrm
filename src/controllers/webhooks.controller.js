import { handleIncoming } from '../services/agent.service.js';

// ==========================================================
//  Webhook do Z-API. Configure na Z-API (Webhooks > "Ao receber")
//  a URL:  https://SEU-APP.up.railway.app/webhooks/whatsapp
//
//  O payload do Z-API varia conforme o evento. Tratamos mensagens
//  de texto recebidas e ignoramos as enviadas por nós (fromMe).
// ==========================================================
export async function whatsappWebhook(req, res) {
  // Responde rápido para a Z-API não reenviar; processa em background.
  res.status(200).json({ received: true });

  try {
    const body = req.body || {};

    // Ignora mensagens que nós mesmos enviamos.
    if (body.fromMe) return;

    // Telefone do contato (Z-API manda em "phone").
    const phone = body.phone || body.participantPhone;
    if (!phone) return;

    const pushName = body.senderName || body.chatName || null;

    // Extrai o texto (Z-API: text.message). Outros tipos podemos tratar depois.
    const text =
      body.text?.message ||
      body.message?.text ||
      body.body ||
      null;

    if (!text) {
      // Mídia/áudio/etc. — opcionalmente avise o time. Por ora, ignora.
      console.log('[webhook] mensagem sem texto, ignorada.');
      return;
    }

    await handleIncoming({ phone, text, pushName });
  } catch (e) {
    console.error('[webhook] erro ao processar:', e.message);
  }
}
