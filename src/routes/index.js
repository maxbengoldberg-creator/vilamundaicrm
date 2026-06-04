import { Router } from 'express';
import { requireApiKey } from '../middleware/auth.js';
import { whatsappWebhook } from '../controllers/webhooks.controller.js';
import { runAgent, generateAutomation } from '../controllers/agent.controller.js';
import * as crm from '../controllers/crm.controller.js';

const router = Router();

// Healthcheck (Railway usa para saber se está no ar)
router.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ----- Webhook do WhatsApp (SEM api-key: quem chama é a Z-API) -----
router.post('/webhooks/whatsapp', whatsappWebhook);

// ----- API administrativa (protegida por x-api-key) -----
const api = Router();
api.use(requireApiKey);

// Agente
api.post('/agent/run', runAgent);                  // dispara o agente manualmente
api.post('/automations/generate', generateAutomation); // prompt -> fluxo (Claude)

// Leads
api.get('/leads', crm.listLeads);
api.post('/leads', crm.createLead);
api.get('/leads/:id', crm.getLead);
api.patch('/leads/:id', crm.updateLead);
api.patch('/leads/:id/ai', crm.toggleAI);

// Conversas
api.get('/conversations', crm.listConversations);
api.get('/conversations/:id/messages', crm.getConversationMessages);
api.post('/conversations/:id/finish', crm.finishConversation);

// Automações
api.get('/automations', crm.listAutomations);
api.patch('/automations/:id', crm.updateAutomation);

router.use('/api/v1', api);

export default router;
