# Vila Mundaí CRM — Contexto do Projeto

CRM de hospedagem com agente de IA que atende leads no WhatsApp, integrado a PMS Hospedin e Z-API. Dono: Max Goldberg (CEO Max). Hospedagem em Mundaí, Porto Seguro/BA — Rua do Telégrafo, 150, 500m da praia.

**Documento completo de arquitetura, gaps e roadmap: ver `ARQUITETURA.md`.**

## Nomenclatura do sistema
- **Atendente Max** — Agente 1: atende leads no WhatsApp (em produção).
- **Gerente Max** — Agente 2: simula, analisa e intervém (a construir; canal de intervenção já existe via POST /agent/run com operador:true).
- **CEO Max** — Max Goldberg: aprova toda decisão crítica antes de produção. Nenhum agente altera produção sozinho.

## Stack
- Node.js + Express + PostgreSQL (ES modules)
- Deploy: Railway (auto-deploy do branch main do GitHub)
- WhatsApp: Z-API | IA: API Anthropic (Claude) | PMS: Hospedin | Fotos/PDFs: Cloudinary
- Contrato PDF: docxtpl + LibreOffice via script Python (nixpacks instala)

## Estrutura
- src/config/ (env.js, db.js)
- src/db/ (schema.sql, clientes.sql, migrate.js) — migrações idempotentes também em server.js
- src/routes/index.js
- src/controllers/ (webhooks, agent, crm, clientes, stages, fotos, contrato)
- src/services/ (claude.service, agent.service, stage.prompts, reception.prompt, zapi.service, hospedin.service, cloudinary.service, contrato.service)
- src/models/ (lead, conversation, message, automation, automation_stage, reservation, cliente, setting)
- src/tools/ (index.js = definições, handlers.js = execução)
- src/jobs/ (morno.job — DESATIVADO de propósito; morno é estágio passivo)
- public/index.html (CRM SPA completo)

## Como funciona o Atendente Max
webhook Z-API → resolve identidade (@lid → telefone real via leads.lid) → **persistir-primeiro** (lead/conversa/mensagem SEMPRE gravados antes de qualquer decisão) → cliente (recepção) ou lead (vendas) → checa robot_enabled e ai_enabled (só decidem se RESPONDE, nunca se registra) → delays (40s primeira / 15s curta / 5s normal; Meta Ads 10s com abertura fixa; ordem do operador sem delay) → janela 20 msgs → loop tool_use (máx 10 rounds; se estourar, chamada final com tool_choice none garante resposta) → envia em blocos \n\n com 4s.

Mensagens fromMe (celular do operador) → gravadas como humano com dedup (requer toggle "notificar enviadas por mim" na Z-API).

claude.service.js → buildSystemPrompt monta: prompt da etapa (banco, cache 60s) + REGRA_PRECO fixa no código (versão "Comando 01" — ordem do funil; alternativa "Julgamento Conversacional" na memória do projeto, revertida) + bloco "JÁ ACONTECEU" (tags: fotos/orçamento/endereço já enviados). callClaude usa cache no system e loga tokens/custo (bug conhecido: preço hardcoded de Opus, superestima ~5x no Sonnet).

## Preço (regra de ouro)
O preço SEMPRE vem do PMS, que aplica tarifa da faixa de datas + desconto por ocupação (configurado pelo CEO no Hospedin; a API NÃO expõe esses descontos para leitura). Fluxo: consultar_disponibilidade cria **pré-reservas temporárias** no PMS (uma por tipo disponível), lê o total_amount e **cancela** — preço exato por nº de hóspedes. criar_reserva NÃO envia valor (o PMS precifica nativamente). Nunca tabela hardcoded; preço varia por hóspedes e datas → mudou o grupo, reconsulta.

## Hospedin (PMS) — dados reais
- Base: https://pms-api.hospedin.com/api/v2 | account_id: vila-mundai
- Auth: POST /authentication/sessions {email,password} → token (dura ~5 dias, cacheado 4)
- Categorias (place_type_id): 178135=1Q Térreo, 179290=1Q Superior, 179291=2Q Térreo, 178729=2Q Superior
- Unidades (places) por tipo em hospedin.service.js; capacidade: 1Q=5 pessoas, 2Q=7
- sale_channel_id do robô (Chat IA): 269875
- Criar reserva: guest {name} primeiro, depois POST /reservations status pre_reservation, place_id obrigatório. NÃO enviar daily_cents (o POST ignora; o PMS precifica pelo calendário)
- Cancelar: PATCH /reservations/{id} {status:'canceled'}
- Disponibilidade: GET /place_types/{id}/rates_and_availabilities?start_date&end_date (rate_price em cents por DIA, availability por dia; exige TODAS as noites livres; só tarifa cheia — sem desconto por ocupação)
- Swagger: https://pms.hospedin.com/api-docs/v1/swagger.yaml
- Endpoints internos do CRM: POST /api/v1/pms/cotacao (cotação nativa) e DELETE /api/v1/pms/reservations/:id

## Modo do agente (Modelo 1 vs Modelo 2)
Seletor na aba Agente (setting `agent_mode`, só um ativo por vez, troca sem deploy via /agent/mode):
- **Modelo 1** (padrão): corpo do prompt = `prompt_body` da etapa (aba Fluxos).
- **Modelo 2**: corpo = camadas do Laboratório compostas em runtime (C1 identidade + C2 fatos + ficha + C4 da etapa).
A única diferença entre os modos é o CORPO por etapa. As **regras de condução** (REGRA_PRECO no código, ou C3 publicada) e o bloco "JÁ ACONTECEU" são SEMPRE anexados — compartilhados pelos dois modos. Logo, regra de conduta nova vai em REGRA_PRECO e vale nos dois. O Simulador testa só rascunhos no formato Modelo 1.

## Versionamento (a partir de 2026-06)
Toda mudança de comportamento vira uma "Atualização X.Y": commit + **git tag `atualizacao-X.Y`** + entrada no **CHANGELOG.md**. Para reverter: `git checkout atualizacao-X.Y -- <arquivo>` (regras/código) ou pelas revisões da aba Fluxos (prompts M1). Mudanças de prompt/camada são feitas via API em produção (runtime, cache 60s) e NÃO ficam no git — só o CHANGELOG as registra; código (REGRA_PRECO, handlers) fica no git. Estado atual: 4.9/5.1 (REGRA_PRECO enxuta + preço exato), 5.2 (lead do site), 5.3 (nome com rapport + grupo 1-3 só 1 quarto). **Modo em produção: Modelo 2.**

## Login e avisos
- **Login real** (4.8): usuário `maxbgoldberg`, senha guardada como hash sha256 (sobrescrevível por env CRM_USER/CRM_PASS_HASH). `POST /api/v1/auth/login` (público) → token HMAC 30d. A API key saiu do HTML; middleware aceita Bearer token OU x-api-key (só integrações). `src/services/auth.js`.
- **Aviso "Novo Lead"** (4.6/4.7): novo lead na 1ª mensagem → WhatsApp pro dono (texto fixo "Novo Lead"). Configurável na aba Agente (settings notify_lead_phone/enabled).

## Z-API / Meta (integração) — diagnóstico e pendência
- **Instância do CRM: `3F426948DA59C2C0D026BE9C7B4BA8CB`** (número da Vila 557399547899). Webhook "Ao receber" → /webhooks/whatsapp. Há OUTRA instância (datacrazy) que NÃO é do CRM — manter só a do CRM.
- **Meta IA do WhatsApp Business derruba a Z-API** — manter desligada.
- Diagnóstico: `GET /api/v1/zapi/status` (conexão + device) e `GET /api/v1/webhooks/log` (últimos hits recebidos).
- Meta Ads → leads: quebrou em 14/06 (conector Meta→planilha caiu, "Acesso a leads" vazio) e foi **resolvido em 16/06**. O Apps Script da planilha só faz Planilha→CRM. Se cair de novo: o conector Meta→planilha (externo) é o suspeito; alternativa durável é **Click-to-WhatsApp** (lead clica → WhatsApp → CRM, sem planilha/conector).

## Funil (colunas no Kanban)
qualif → apres → quente → negociacao → contrato → **assinatura** → pagamento → ganho
Desvios/IA off (atendimento humano): **lead_site** (formulário do site, detectado por `pareceSite`), **reveillon** (datas pegando 30/31 dez), **contrato**/**assinatura** (pós pré-reserva/contrato), **morno**, **frio**, **segunda_tentativa**. **sem_datas** (lead sem datas — IA leve, reengaja quando trouxer datas; robô estaciona de qualif/apres após máx 2 perguntas de data).
- `mover_funil('contrato')` desliga a IA; "Enviar contrato" (aba Pipelines) move para assinatura + IA off.
- Robô avança UMA etapa por vez (trava server-side); não conhece "frio".
- Humano move livre: Kanban, modal, ou seletor de etapa na ficha do chat.
- Tag "ganho" força stage ganho; criar_reserva tem trava de acomodação (ficha do lead).
- Boas-vindas (aba Clientes) → lead vai para ganho com IA off + dados da reserva copiados.

## Regras do agente (tom)
- Frases curtas por quebras de linha, sem emojis, sem listas, sem exclamação, sem travessão.
- Futuro simples, sem entusiasmo forçado, confirmar com "ok"/"certo", espelhar saudação.
- Datas sempre AAAA-MM-DD. Nunca inventar preços (vêm do PMS).
- 5% Pix só se o lead pedir. Cartão até 3x; acima, gerente. "À vista" = pagamento.
- "Pré-reserva" até contrato assinado + sinal pago.
- Capacidade: 1Q=5, 2Q=7; o lead escolhe o tipo. Localização → enviar_midia "endereco".
- Dados completos (nome, CPF, nascimento) só na criação da pré-reserva, juntos.
- Nunca repetir fotos/orçamento/mapa já enviados (tags controlam).

## CRM (public/index.html)
- Atendimentos: polling 4s, ficha do lead (etapa editável, datas, hóspedes, valor, tags, motivo escalonamento), toggle IA/Humano, resumo Haiku + chance de conversão (cacheado), não-lidas, selo AGUARDANDO HUMANO, filtro funil, busca, Instruir (ordem do operador).
- Cuidado: IDs do Postgres chegam como STRING no front — comparar com sameId()/String().
- Login é decorativo e a API key está no HTML (gap de segurança conhecido, prioridade alta).

## Gaps críticos abertos (ver ARQUITETURA.md §3)
1. gerar_link_pagamento é STUB (link falso). 2. Segurança CRM. 3. Áudio/imagem de lead ignorados. 4. Custo IA inflado ~5x. 5. @lid sem mapeamento cria contato provisório.

## Deploy
git add . && git commit -m "msg" && git push  (Railway faz deploy sozinho, ~2 min; build pesado por LibreOffice)
Health: https://vilamundaicrm-production.up.railway.app/health
Prompts das etapas: editar via CRM (aba Fluxos) ou PATCH /api/v1/automations/stages/:stage — valem sem deploy (cache 60s).
