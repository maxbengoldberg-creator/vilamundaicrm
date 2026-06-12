import { Router } from 'express';
import { requireApiKey } from '../middleware/auth.js';
import { whatsappWebhook, metaLeadsWebhook } from '../controllers/webhooks.controller.js';
import { runAgent, generateAutomation } from '../controllers/agent.controller.js';
import * as crm from '../controllers/crm.controller.js';
import * as clientes from '../controllers/clientes.controller.js';
import * as stages from '../controllers/stages.controller.js';
import * as gerente from '../controllers/gerente.controller.js';
import * as fotos from '../controllers/fotos.controller.js';
import * as contrato from '../controllers/contrato.controller.js';

const router = Router();

router.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

router.post('/webhooks/whatsapp', whatsappWebhook);
router.post('/webhooks/meta-leads', metaLeadsWebhook);

const api = Router();
api.use(requireApiKey);

// Agente
api.post('/agent/run', runAgent);
api.post('/automations/generate', generateAutomation);

// Cotação nativa no PMS (cria pré-reserva sem valor; o PMS precifica)
api.post('/pms/cotacao', crm.cotacaoPms);
// Cancelar reserva no PMS por ID
api.delete('/pms/reservations/:id', crm.cancelarReservaPms);

// Leads
api.get('/leads', crm.listLeads);
api.post('/leads', crm.createLead);
api.get('/leads/:id', crm.getLead);
api.patch('/leads/:id', crm.updateLead);
api.patch('/leads/:id/ai', crm.toggleAI);
api.delete('/leads/:id', crm.deleteLead);

// Contrato (gera com docxtpl + LibreOffice, envia via Z-API)
api.get('/leads/:id/contrato', contrato.verContrato);
api.post('/leads/:id/contrato/enviar', contrato.enviarContrato);

// Conversas
api.get('/conversations', crm.listConversations);
api.get('/conversations/:id/messages', crm.getConversationMessages);
api.post('/conversations/:id/send', crm.sendManual);
api.post('/conversations/:id/finish', crm.finishConversation);
api.post('/conversations/:id/read', crm.markConversationRead);
api.post('/conversations/:id/resumo', crm.resumoConversa);

// Automações — prompts por etapa (deve vir antes de /automations/:id)
api.get('/automations/stages', stages.listStages);
api.patch('/automations/stages/:stage', stages.updateStage);
// Rascunho (draft) + histórico de versões de prompt
api.patch('/automations/stages/:stage/draft', stages.saveDraft);
api.post('/automations/stages/:stage/draft/promover', stages.promoteDraft);
api.get('/automations/stages/:stage/revisions', stages.listRevisions);
api.get('/automations/revisions/:id', stages.getRevision);
api.post('/automations/stages/:stage/revisions/:id/restore', stages.restoreRevision);

// Regras globais do agente (código, leitura)
api.get('/automations/regras-globais', stages.regrasGlobais);

// Gerente Max — Simulador (sandbox: não toca WhatsApp, PMS nem leads reais)
api.post('/gerente/simulacoes', gerente.criarSimulacao);
api.get('/gerente/simulacoes', gerente.listarSimulacoes);
api.get('/gerente/simulacoes/:id', gerente.obterSimulacao);
api.delete('/gerente/simulacoes/:id', gerente.apagarSimulacao);
api.post('/gerente/simulacoes/:id/mensagem', gerente.mensagemSimulacao);
api.post('/gerente/simulacoes/:id/lead-ia', gerente.cicloIaLead);
api.post('/gerente/simulacoes/:id/avaliar', gerente.avaliar);
// Sugestões do Gerente Max (aplicáveis como rascunho na aba Fluxos)
api.get('/gerente/insights', gerente.listarInsights);
api.post('/gerente/insights/:id/aplicar', gerente.aplicarInsight);
api.post('/gerente/insights/:id/descartar', gerente.descartarInsight);

// Automações — builder genérico (legado)
api.get('/automations', crm.listAutomations);
api.patch('/automations/:id', crm.updateAutomation);

// Fotos
api.get('/fotos', fotos.listFotos);
api.patch('/fotos/:id', fotos.updateFoto);
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
