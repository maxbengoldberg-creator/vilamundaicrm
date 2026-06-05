# Vila Mundaí CRM — Contexto do Projeto

CRM de hospedagem com agente de IA (Max) que atende leads no WhatsApp, integrado a PMS Hospedin e Z-API. Dono: Max Goldberg. Hospedagem em Mundaí, Porto Seguro/BA.

## Stack
- Node.js + Express + PostgreSQL (ES modules)
- Deploy: Railway (auto-deploy do branch main do GitHub)
- WhatsApp: Z-API | IA: API Anthropic (Claude) | PMS: Hospedin

## Estrutura
- src/config/ (env.js, db.js)
- src/db/ (schema.sql, clientes.sql, migrate.js)
- src/routes/index.js
- src/controllers/ (webhooks, agent, crm, clientes)
- src/services/ (claude.service.js, agent.service.js, reception.prompt.js, zapi.service.js, hospedin.service.js)
- src/models/ (lead, conversation, message, automation, reservation, cliente, setting)
- src/tools/ (index.js = definições, handlers.js = execução)

## Como funciona o agente
agent.service.js → recebe msg do webhook → verifica se telefone é CLIENTE (tabela clientes, modo recepção) ou LEAD (fluxo vendas) → checa interruptor geral (Setting 'robot_enabled') → checa lead.ai_enabled → carrega histórico (Message.listRecent, janela 20 msgs) → loop tool_use (máx 6 rounds) → responde via Z-API.

claude.service.js → buildSystemPrompt(lead) monta o prompt conforme lead.stage. callClaude() usa cache no system e loga tokens/custo.

## Hospedin (PMS) — dados reais
- Base: https://pms-api.hospedin.com/api/v2 | account_id: vila-mundai
- Auth: POST /authentication/sessions {email,password} → token (dura ~5 dias, cacheado)
- Categorias (place_type_id): 178135=1Q Térreo, 179290=1Q Superior, 179291=2Q Térreo, 178729=2Q Superior
- sale_channel_id do robô (Chat IA): 269875
- Criar reserva: cria guest {name} primeiro, depois POST /reservations com status pre_reservation, place_id obrigatório, valores em cents.
- Disponibilidade: GET /place_types/{id}/rates_and_availabilities?start_date&end_date

## Etapas do funil (stage)
qualif → apres → quente → negociacao → contrato → pagamento → ganho
Desvio: morno (quente parado 48h sem resposta).

## Regras do agente
- Tom: frases curtas separadas por quebras de linha (enter), naturais, sem excesso de pontos finais, sem emojis, sem listas.
- O robô avança UMA etapa por vez, NUNCA pula. Só o humano move livre entre funis.
- Cada etapa deve ter seu próprio prompt enxuto (objetivo: separar para economizar tokens e focar comportamento).
- Datas sempre em AAAA-MM-DD.
- Nunca inventar preços (vêm do PMS).

## Tarefas pendentes (1 a 4 desta leva)
1. Adicionar etapas no funil: negociacao, contrato, pagamento, morno.
2. Criar 8 prompts separados (um por etapa) em vez do prompt único gigante.
3. claude.service.js carregar SÓ o prompt da etapa atual do lead.
4. Trava no backend: robô só pode mover lead para a etapa imediatamente seguinte (nunca pular).

## Deploy
git add . && git commit -m "msg" && git push  (Railway faz deploy sozinho)
Health: https://vilamundaicrm-production.up.railway.app/health
