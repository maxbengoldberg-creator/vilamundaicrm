import { Router } from 'express';
import { requireApiKey } from '../middleware/auth.js';
import { whatsappWebhook, metaLeadsWebhook } from '../controllers/webhooks.controller.js';
import { runAgent, generateAutomation } from '../controllers/agent.controller.js';
import * as crm from '../controllers/crm.controller.js';
import * as clientes from '../controllers/clientes.controller.js';
import * as stages from '../controllers/stages.controller.js';
import * as fotos from '../controllers/fotos.controller.js';

const router = Router();

router.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

router.post('/webhooks/whatsapp', whatsappWebhook);
router.post('/webhooks/meta-leads', metaLeadsWebhook);

const api = Router();
api.use(requireApiKey);

// Agente
api.post('/agent/run', runAgent);
api.post('/automations/generate', generateAutomation);

// Leads
api.get('/leads', crm.listLeads);
api.post('/leads', crm.createLead);
api.get('/leads/:id', crm.getLead);
api.patch('/leads/:id', crm.updateLead);
api.patch('/leads/:id/ai', crm.toggleAI);
api.delete('/leads/:id', crm.deleteLead);

// Conversas
api.get('/conversations', crm.listConversations);
api.get('/conversations/:id/messages', crm.getConversationMessages);
api.post('/conversations/:id/send', crm.sendManual);
api.post('/conversations/:id/finish', crm.finishConversation);

// Automações — prompts por etapa (deve vir antes de /automations/:id)
api.get('/automations/stages', stages.listStages);
api.patch('/automations/stages/:stage', stages.updateStage);

// Automações — builder genérico (legado)
api.get('/automations', crm.listAutomations);
api.patch('/automations/:id', crm.updateAutomation);

// Fotos
api.get('/fotos', fotos.listFotos);
api.post('/fotos/sync', fotos.syncFotosHandler);
api.post('/fotos/migrar', fotos.migrarFotos);
api.delete('/fotos/all', fotos.clearFotos);

// Clientes (boas-vindas / hóspedes confirmados)
api.post('/clientes/importar', clientes.importarChegadas);
api.get('/clientes', clientes.listClientes);
api.patch('/clientes/:id', clientes.updateCliente);
api.delete('/clientes/:id', clientes.deleteCliente);
api.post('/clientes/:id/boas-vindas', clientes.enviarBoasVindas);
api.get("/robot/status", clientes.getRobotStatus);
api.post("/robot/status", clientes.setRobotStatus);

router.use('/api/v1', api);

export default router;
