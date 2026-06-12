# ARQUITETURA — VILA MUNDAÍ CRM AGENT SYSTEM

*Validado contra o código em produção (branch main, 12/06/2026).*

═══════════════════════════════════════
## NOMENCLATURA OFICIAL DO SISTEMA
═══════════════════════════════════════

| Nome | Papel | Estado |
|---|---|---|
| **Atendente Max** | Agente 1 — atende leads no WhatsApp (vendas + recepção de hóspedes) | **Em produção** (`handleIncoming` + prompts por etapa + 10 ferramentas) |
| **Gerente Max** | Agente 2 — analisa, simula, monitora e intervém. Engloba as 3 camadas: Simulador, Analisador Passivo, Gerente Ativo | A construir (fundações prontas: canal de intervenção via `POST /agent/run` e resumo+conversão por Haiku) |
| **CEO Max** | Max Goldberg — dono do sistema. Aprova **toda** decisão crítica antes de aplicar em produção | Sempre no centro do loop |

═══════════════════════════════════════
## ARQUITETURA — AGENTIC LOOP CONTÍNUO
═══════════════════════════════════════

```
            ┌─────────────────────────────────────────────┐
            │                  CEO MAX                    │
            │   (aprova decisões críticas antes de        │
            │    qualquer aplicação em produção)          │
            └──────────────▲───────────────┬──────────────┘
                  notifica │               │ aprova
                           │               ▼
   ┌───────────────────────┴───────────────────────────┐
   │                   GERENTE MAX                     │
   │                                                   │
   │  SIMULADOR ──alimenta──► ANALISADOR ──alimenta──► │
   │  (testa o Atendente     (lê conversas reais,      │   GERENTE ATIVO
   │   contra leads           extrai padrões,          │   (detecta desvio em
   │   simulados)             gera insights)           │    conversa real)
   └─────────▲──────────────────────▲──────────────────┘
             │                      │                  │
       testa ajustes          resultado volta    intervém (com aprovação
       aprovados              ao Analisador      do CEO) via /agent/run
             │                      │                  │
            ┌┴──────────────────────┴──────────────────▼┐
            │               ATENDENTE MAX               │
            │     (WhatsApp, leads reais, produção)     │
            └───────────────────────────────────────────┘

         BASE DE APRENDIZADO (alimenta e é alimentada pelos 3 módulos)
```

**O ciclo nunca para**: o Simulador testa o Atendente Max e propõe ajustes → o CEO Max aprova → o ajuste validado vai à produção → o Analisador observa o efeito nas conversas reais → alimenta o Gerente Max → que detecta desvios ao vivo e, com aprovação do CEO, intervém no Atendente Max → o resultado da intervenção volta ao Analisador. O sistema aprende e se sofistica continuamente, com o humano sempre no ponto de decisão.

**Regra de ouro do sistema** (vale para todos os módulos): *nenhum agente altera produção sozinho.* O Gerente Max sugere, simula e mostra evidência; quem assina é o CEO Max.

═══════════════════════════════════════
## 1. O QUE O ATENDENTE MAX JÁ FAZ HOJE
═══════════════════════════════════════

### ATENDIMENTO

- Recebe mensagens via webhook Z-API (`POST /webhooks/whatsapp`)
- **Identidade `@lid`**: o WhatsApp às vezes entrega o remetente como identificador de privacidade (`...@lid`) em vez do telefone. O sistema mapeia LID → telefone real (coluna `leads.lid`) para a mesma pessoa não virar dois contatos. Mensagens `@lid` sem mapeamento ainda criam contato provisório (gap residual).
- **Invariante persistir-primeiro**: TODA mensagem recebida é gravada (lead criado em qualificação + conversa + mensagem) **antes** de qualquer decisão da IA. O interruptor geral e o `ai_enabled` por lead controlam apenas *se o robô responde*, nunca *se o lead existe*.
- **Mensagens `fromMe`**: o que o operador envia pelo celular é gravado como atendimento humano (dedup por substring contra ecos da IA/CRM). *Depende do toggle "Notificar as enviadas por mim também" na Z-API.*
- Identifica cliente confirmado (modo recepção) vs lead (modo vendas)
- Verifica `robot_enabled` (geral) e `ai_enabled` (por lead E por cliente)
- Delays: 40s primeira mensagem, 15s mensagem curta (≤6 palavras), 5s normal. Meta Ads: 10s com abertura fixa, sem chamar IA. Ordem do operador: **sem delay**
- Loop de tool_use: **10 rounds**. Se estourar em tool_use, uma última chamada com `tool_choice: none` força a mensagem final — o lead nunca fica no vácuo
- Envia resposta em blocos separados por `\n\n` com 4s de intervalo
- Lock por telefone contra processamento concorrente (in-memory; gap: mensagem que chega após a leitura do histórico pode ficar sem resposta; quebra com 2+ réplicas)
- **Instrução do operador** (`POST /agent/run`, `operador: true`): tratada como ORDEM, não como fala do lead. Roda mesmo com IA desligada, sem delay, não polui o histórico; o agente usa o histórico só como contexto

### FUNIL DE VENDAS

**9 colunas** no Kanban: `qualif → apres → quente → negociacao → contrato → pagamento → ganho` + desvios **morno** e **frio**.

- **Morno**: o job automático de 48h está **DESATIVADO** (comentado no server.js, religável). Morno hoje é estágio **passivo** igual ao frio: estacionamento manual com IA desligada, sem automação
- **Frio**: estacionamento manual de leads sem potencial; mover para frio/morno (pelo seletor do chat) desliga a IA automaticamente
- Robô avança UMA etapa por vez (trava server-side em `mover_funil`); não conhece "frio"
- Humano move livremente: Kanban (drag), modal do lead, e seletor de etapa na ficha do chat de Atendimentos
- Tag "ganho" força stage ganho; `blocked_tags` da etapa desviam para ganho
- **Trava de acomodação**: `criar_reserva` bloqueia se o tipo de apto divergir do que está na ficha do lead

### PROMPTS

- Um por etapa, tabela **`automations_stages`**, editável no CRM (aba Fluxos), cache 60s, modelo configurável por etapa
- Placeholders reais: `{{hoje}}`, `{{ano}}`, `{{nome}}`, `{{checkin}}`, `{{checkout}}`, `{{guests}}`, `{{sinal_30}}`, `{{condicoes_pagamento}}`
- **Blocos injetados por código** (em toda etapa, fora do banco — `src/services/stage.prompts.js`):
  - **REGRA_PRECO "Comando 01"**: ordem do funil rígida (sem preço/pagamento em qualif/apres), preço varia por hóspedes/datas (recalcular no PMS a cada mudança de grupo), pagamento junto do valor, dados pessoais só na pré-reserva. *Versão alternativa "Julgamento Conversacional" salva na memória do projeto — testada e revertida (ficou rasa)*
  - **JÁ ACONTECEU NESTA CONVERSA**: estado por tags (fotos 1Q/2Q/área externa enviadas, endereço enviado, orçamento apresentado) para nunca reofertar
  - Contexto de primeira mensagem (saudação por horário) e ordem do operador quando aplicável
- Capacidades nos prompts: 1 quarto até **5** pessoas, 2 quartos até **7** — o lead escolhe o tipo

### FERRAMENTAS (10)

| Ferramenta | Estado real |
|---|---|
| `consultar_disponibilidade` | Checa vagas em TODAS as noites (`.every`); o preço vem de **pré-reservas temporárias criadas e canceladas no PMS** (`cotarNativo`) — o Hospedin calcula tarifa da faixa + desconto por ocupação. Retorna diária média, noites e total prontos. Marca tag `orcamento_apresentado` |
| `cotar` | Legado — registra valor_cotado, mas o preço real vem da consulta |
| `extrair_dados_lead` | Inclui CPF e data de nascimento |
| `qualificar_lead` | Score + tags |
| `mover_funil` | Sequencial com trava server-side |
| `enviar_midia` | Por tipo de apto + `endereco` (mapa). Aplica tags de mídia enviada |
| `criar_reserva` | **Sem enviar valor** — o PMS precifica nativamente. Trava de acomodação. Atualiza valor_cotado com o total do PMS |
| `salvar_condicoes` | JSONB no lead |
| `escalar_humano` | Desliga IA + salva o motivo em `extra` (aparece na ficha do chat) |
| `gerar_link_pagamento` | **STUB — gera link FALSO**. Gap crítico: lead na etapa pagamento recebe link quebrado |

### INTEGRAÇÕES

- **Hospedin**: disponibilidade por noite, **cotação nativa via pré-reserva** (`POST /pms/cotacao` + `DELETE /pms/reservations/:id`), criação de pré-reserva, cancelamento, importação de chegadas (Airbnb/Booking). *Limite: a API não expõe descontos por ocupação para leitura (por isso a cotação via pré-reserva) e não há endpoint de escrita de tarifa de calendário*
- **Z-API**: texto, imagem, vídeo, PDF; webhook de recebidas; enviadas-por-mim pendente de ativação no painel
- **Cloudinary**: fotos por tipo de apto + pasta `endereco`; PDFs de contrato (URL pública adivinhável — risco LGPD)
- **Meta Ads**: webhook de formulário + detecção por texto ("preenchi seu formulário")
- **Boas-vindas (Clientes)**: ao enviar, desliga IA no cliente E no lead, move lead para **ganho**, copia origem (airbnb/booking), datas, hóspedes e valor da reserva, vincula conversas e grava a mensagem no painel

### RASTREAMENTO

- Custo por lead — **bug conhecido: preço hardcoded de Opus ($15/$75), superestima ~5x quando roda Sonnet; ignora cache**
- Origem (whatsapp, meta_ads, airbnb, booking, reserva), tags, score, condições
- Tags de estado da conversa, LID, motivo de escalonamento, não-lidas (`last_read_at`), resumo + conversão por conversa

### CRM FRONTEND

- Kanban **9 colunas**, badges IA/Humano, botão Prompt, contrato (ver/enviar) nos cards da coluna contrato
- **Fluxos**: edição de prompts com aviso "aplica em até 60s"
- **Atendimentos**: polling 4s (independe da IA), ficha do lead (etapa **editável**, check-in/out, hóspedes, valor, tags, motivo de escalonamento), toggle IA/Humano, **resumo do agente via Haiku com chance de conversão** (cacheado, regenera só com mensagens novas), não-lidas + ordenação por pendência, selo AGUARDANDO HUMANO, filtro por funil, busca, botão Instruir, confirmação ao Finalizar, separadores por dia, mensagens internas filtradas
- Dashboard: KPIs, leads por etapa, últimos leads

═══════════════════════════════════════
## 2. REGRAS GERAIS DO ATENDENTE MAX (TOM)
═══════════════════════════════════════

- Frases curtas, diretas, conectadas por vírgulas
- Sem emojis, sem listas, sem hífens, sem travessão
- Futuro simples (virão, ficarão) nunca condicional (viriam)
- Sem entusiasmo forçado ("Perfeito", "Que maravilha", "Boa notícia")
- Sem intimidade não criada (sem diminutivos que o lead não usou)
- Confirmar com o mínimo: "ok", "certo"
- Não anunciar que vai responder — responde direto
- Sem exclamação em nenhuma situação
- Espelhar saudação do lead
- Não oferecer desconto do Pix antes do lead pedir
- Cartão em até 3x; acima disso precisa do gerente
- Quando escalar: "Vou verificar aqui internamente e já te retorno"
- Sempre "pré-reserva" até contrato assinado e sinal pago
- Responder dúvida primeiro, qualificar depois
- Capacidades: 1Q = 5 pessoas, 2Q = 7; o lead escolhe o tipo, o bot não impõe
- "À vista" = forma de pagamento, nunca paisagem
- Preço varia por hóspedes/datas → sempre reconsultar o PMS; calcular total óbvio (2+primo=3) sem perguntar
- Sem comparação do bairro com Taperapuã
- Localização → enviar mapa (`enviar_midia endereco`) + Rua do Telégrafo, 150
- Fechamento natural, sem "tem interesse em garantir?" — pergunta uma vez só
- Nunca repetir o que já aconteceu (fotos, orçamento, mapa)

═══════════════════════════════════════
## 3. GAPS REAIS (priorizado)
═══════════════════════════════════════

**Críticos (negócio):**
1. `gerar_link_pagamento` é stub — link falso na etapa de pagamento
2. Segurança: login do CRM é decorativo + API key exposta no HTML (qualquer pessoa com a URL lê CPFs e envia WhatsApp pelo número da Vila)
3. Áudio/imagem do lead: ignorados em silêncio (nem aviso ao operador)
4. Tarifas no PMS: revisar cadastro (ex: inversão Superior/Térreo em 31/07–05/08; o bot reporta fielmente o que o PMS calcula)

**Importantes (técnico):**
5. `@lid` sem mapeamento prévio ainda cria contato provisório; conversas órfãs existentes podem ser mescladas
6. Custo IA superestimado ~5x (corrigir preço por modelo)
7. Lock in-memory: mensagem durante o processamento pode ficar sem resposta; quebra com 2+ réplicas
8. Janela de 20 mensagens em conversas longas (tool_results consomem a janela)
9. Falha da Anthropic (429/529) = silêncio para o lead, sem alerta
10. Contrato em URL pública adivinhável no Cloudinary (LGPD)

**Vendas:**
- Fotos sem comentário contextual
- Sem detecção de sinais sutis de compra (tom, urgência, entusiasmo)
- Sem follow-up ativo intra-conversa; reaquecimento 100% manual (morno passivo por decisão do CEO)
- Sem personalização por perfil emocional do lead

═══════════════════════════════════════
## 4. VISÃO DO CEO MAX
═══════════════════════════════════════

**SIMULADOR DE VENDAS** (Gerente Max — Camada 1):
Usa o banco de chats reais como base. Simula conversas para testar o Atendente Max, identificar erros, inconsistências, falhas e oportunidades de melhoria nos prompts.

Duas modalidades:
- **Automática**: o simulador usa os chats reais como referência e roda conversas sozinho contra o Atendente Max
- **Manual**: o CEO Max conduz o papel do lead, testando o agente na prática

Processo de melhoria controlado pelo CEO:
1. O simulador detecta um problema e sugere um ajuste no prompt
2. O CEO revisa e aprova o ajuste antes de qualquer alteração
3. O ajuste é testado no simulador — observa-se se houve melhoria real
4. Só depois de validado no simulador o ajuste vai para produção (leads reais)

**ANALISADOR PASSIVO** (Gerente Max — Camada 2):
Lê as conversas reais e alimenta uma base de conhecimento que torna o agente progressivamente mais sofisticado em vendas. Não interfere — só observa, aprende e reporta.

**GERENTE DE VENDAS ATIVO** (Gerente Max — Camada 3):
Quando detecta inconsistência ou oportunidade perdida numa conversa real, não age sozinho — chama o CEO primeiro. Mostra o que detectou, sugere como interviria e pergunta se deve intervir. Só age com aprovação. Quando aprovado, injeta a instrução via `POST /agent/run` (canal já existente). Acompanha se o Atendente Max corrigiu o rumo; quando a conversa volta ao trilho, volta à posição de analista.

**BASE DE APRENDIZADO**:
Tudo que o simulador aprende, o analisador observa e o gerente intervém fica registrado numa base que alimenta os três módulos.

═══════════════════════════════════════
## 5. ARQUITETURA TÉCNICA DOS 3 MÓDULOS
═══════════════════════════════════════

**Camada 1 — Simulador (construir primeiro, modalidade manual antes).**
Peças que já existem: histórico real no banco (`messages.raw` preserva até os tool_calls), prompts versionáveis por etapa, e o pipeline do agente é uma função (`handleIncoming`) — dá para invocá-la em "modo sandbox" sem Z-API e sem PMS real (mockando `zapi.sendText` e `cotarNativo`). O que falta: ambiente de teste isolado (leads/conversas com flag `simulacao`), um "ator-lead" (modelo barato interpretando perfis extraídos dos chats reais), e o relatório pós-simulação (o mesmo motor do resumo Haiku, com rubrica de vendas).

**Camada 2 — Analisador.**
Evolução natural do resumo atual: job sobre conversas finalizadas, grava em tabela `insights`, relatório periódico com sugestões — CEO aprova antes de aplicar. Nunca interfere em conversas ativas. Custo controlado com Haiku.

**Camada 3 — Gerente Ativo.**
O canal de injeção existe e é seguro (ordem do operador). Falta: o detector (avaliar conversas ativas paradas/desviadas), a notificação com aprovação (UI no CRM — hoje não há mecanismo de notificação) e o registro de intervenções (o que detectou, o que sugeriu, se o CEO aprovou, qual foi o resultado). O selo AGUARDANDO HUMANO + resumo são o ponto natural de acoplamento.

**Pré-requisito recomendado:** antes da Camada 1, criar o **modo sandbox** (flag que troca Z-API/PMS por mocks) — destrava o simulador e testes seguros de qualquer mudança futura.

═══════════════════════════════════════
## 6. PRÓXIMOS PASSOS
═══════════════════════════════════════

1. ~~Atualizar CLAUDE.md~~ (feito em 12/06/2026)
2. **Segurança do CRM** (login real + chave fora do HTML) — antes de qualquer módulo novo
3. **Pix real no lugar do link fake** na etapa pagamento
4. **Tratar áudio** (mínimo: gravar "[áudio recebido]" + selo aguardando humano)
5. **Modo sandbox** → **Simulador manual** (Camada 1)
6. Analisador (Camada 2) → Gerente Ativo (Camada 3)
7. Limpeza: mesclar conversas `@lid` órfãs, corrigir custo por modelo

═══════════════════════════════════════
## 7. ANÁLISE DO CRM (o motorista da Ferrari)
═══════════════════════════════════════

O Atendente Max é a Ferrari — potente, treinado, sofisticado. Mas quem dirige é o operador pelo CRM. Se o painel for ruim, a Ferrari não performa.

**KANBAN** — Visualização boa (9 colunas, cores, valor e custo no card). Card mostra o essencial sem abrir modal. Assumir conversa: fácil no chat (toggle + Instruir); no Kanban o badge IA/Humano funciona mas é pequeno. Faltam: busca/filtro no Kanban, drag em touch (mobile), indicador de "lead parado há X dias".

**ATENDIMENTOS** — Após a reescrita: polling em tempo real com IA ligada ou desligada, intervenção sem fricção (toggle, Instruir, etapa editável, envio manual), não-lidas e AGUARDANDO HUMANO, resumo com conversão. Gaps: resumo não se atualiza sozinho durante a conversa aberta (decisão de custo), painel direito some em telas <1200px, áudios/imagens do lead invisíveis.

**FLUXOS** — Editar é simples; feedback "aplica em até 60s" existe. Mas é a tela mais perigosa do CRM: **sem histórico de versões, sem desfazer, sem teste antes de salvar**. O episódio Comando 01 vs Julgamento Conversacional provou o valor de versionar. Proposta: tabela `prompt_revisions` + botão restaurar + (futuro) "testar no simulador antes de aplicar". O operador também não vê os blocos injetados por código (REGRA_PRECO etc.) — vale exibi-los em modo leitura.

**CONTRATO** — Fluxo de 2 cliques. Gaps: sem validação de dados faltantes (CPF vazio → contrato com "____" vai pro lead), só aparece na coluna contrato, e o pós-`criar_reserva` depende do humano perceber que precisa enviar (janela morta no momento mais quente da venda).

**VISIBILIDADE** — Custo visível mas inflado 5x (bug). AGUARDANDO HUMANO resolve metade dos "leads que precisam de atenção"; falta "parado há X tempo" e qualquer **sistema de notificação** (push/som/badge no rail) — sem isso o Gerente Ativo da Camada 3 não tem onde chamar o CEO. Gap estrutural de UX a resolver antes da Camada 3.

**Melhorias de maior alavancagem, em ordem:**
1. Notificações no CRM (pré-requisito da Camada 3)
2. Versões de prompt (Fluxos)
3. Indicador de lead parado
4. Validação pré-contrato
5. Responsivo mobile
