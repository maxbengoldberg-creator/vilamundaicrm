# PLANO DE CONSTRUÇÃO — GERENTE MAX

*Plano de implementação derivado de `ARQUITETURA.md`. Como construir o Gerente Max (Agente 2) sobre o Atendente Max (Agente 1) que já roda. Atualizado 12/06/2026.*

═══════════════════════════════════════
## O QUE EU ENTENDI
═══════════════════════════════════════

1. **O Atendente Max já existe e funciona** (vendas no WhatsApp). Não é ele que vamos construir — é o que vamos *melhorar continuamente*.

2. **O Gerente Max é um segundo agente** que cuida do Atendente Max em três papéis que formam um ciclo: **Simulador** (testa) → **Analisador** (observa conversas reais) → **Gerente Ativo** (intervém ao vivo) → resultado volta ao Analisador. O ciclo não para; o sistema fica mais sofisticado com o tempo.

3. **O CEO Max está no centro e nada vai a produção sem ele.** Esta é a regra inviolável: todo agente *sugere e mostra evidência*; quem aprova e assina é o humano. Cada módulo tem um portão de aprovação explícito.

4. **Já existem 3 fundações construídas** (sem saber, fizemos isso esta semana):
   - **Canal de intervenção**: `POST /agent/run` com `operador:true` — injeta ordem no Atendente Max, tratada como comando, não como fala do lead. É exatamente o que o Gerente Ativo precisa.
   - **Embrião do Analisador**: o resumo + chance de conversão por Haiku (cacheado) que já roda na aba Atendimentos. O motor de "ler conversa e avaliar" já existe.
   - **Embrião do versionamento de prompt**: as duas versões do REGRA_PRECO (Comando 01 / Julgamento Conversacional) salvas na memória do projeto — prova de que precisamos de versões reais de prompt no banco.

5. **A peça-chave que falta para começar é o Modo Sandbox**: rodar o pipeline do Atendente Max (`handleIncoming`) sem mandar WhatsApp real e sem tocar no PMS real. Sem isso, não dá para simular nada com segurança. É o pré-requisito da Camada 1.

═══════════════════════════════════════
## PRINCÍPIO INVIOLÁVEL
═══════════════════════════════════════

> Nenhum agente altera produção sozinho. Cada mudança de prompt, cada intervenção em conversa real, passa por um portão de aprovação do CEO Max. Os agentes detectam, simulam, mostram evidência e propõem — o humano decide.

═══════════════════════════════════════
## FASE 0 — FUNDAÇÕES (pré-requisitos)
═══════════════════════════════════════

**0.1 — Modo Sandbox** *(keystone, bloqueia a Camada 1)*
- Flag de execução que troca `zapi.sendText/sendImage` e `hospedin.cotarNativo/criarReserva` por mocks.
- `handleIncoming` roda igual, mas: não envia WhatsApp, não cria reserva real, registra tudo (texto + tool_calls + etapa + prompt usado) num espaço isolado.
- Leads/conversas de simulação marcados com flag `simulacao=true` (não poluem o funil real, não contam custo no dashboard real).
- **Done quando**: dá para "conversar" com o Atendente Max via um endpoint de teste e ver a resposta + quais ferramentas dispararam, sem nenhum efeito colateral real.

**0.2 — Base de Aprendizado (schema)** *(backbone dos 3 módulos)*
- `prompt_revisions` (stage, prompt_body, origem, autor, created_at) — versiona cada prompt; permite restaurar e comparar.
- `simulacoes` (perfil_lead, transcript, relatorio, ajuste_sugerido, status) — saída do Simulador.
- `insights` (padrao, evidencia, sugestao, status, created_at) — saída do Analisador.
- `intervencoes` (conversation_id, detectado, sugerido, aprovado, resultado, created_at) — log do Gerente Ativo.
- **Done quando**: as tabelas existem (migração idempotente em server.js) e os módulos têm onde gravar/ler.

**0.3 — Trilha de segurança** *(paralela, urgente — maior exposição do sistema hoje)*
- Login real no servidor + API key fora do HTML público + rotacionar a chave atual.
- Não bloqueia a construção dos módulos, mas é irresponsável crescer sobre uma porta aberta (CPFs expostos, WhatsApp da Vila acessível por qualquer um com a URL).
- **Decisão do CEO**: fazer antes, em paralelo, ou aceitar o risco por ora.

═══════════════════════════════════════
## FASE 1 — SIMULADOR (Camada 1) — manual primeiro
═══════════════════════════════════════

**1.1 — Runner de simulação** (depende de 0.1)
- Função que recebe uma mensagem "de lead", roda o Atendente Max em sandbox, devolve a resposta + estado (etapa, tools, prompt).

**1.2 — Modalidade MANUAL** (a primeira a entregar)
- Tela no CRM onde o CEO Max faz o papel do lead e conversa com o Atendente Max em sandbox.
- Mostra, a cada turno: a resposta, quais ferramentas dispararam, em que etapa está, qual prompt está ativo.
- **Done quando**: o CEO consegue testar qualquer cenário (lead assertivo, vago, com pet, mudando de pessoas) sem gastar WhatsApp nem PMS.

**1.3 — Relatório pós-simulação**
- Ao fim da conversa, um avaliador (Haiku/Opus) compara contra uma rubrica de vendas → lista erros, inconsistências, oportunidades perdidas → sugere um **ajuste específico** (o trecho exato do prompt a mudar).

**1.4 — Ciclo aprovação → teste → produção**
- CEO aprova o ajuste → aplica numa **versão de teste** do prompt (`prompt_revisions`) → re-roda a simulação → compara antes/depois → se validado, promove a produção. Versionado e reversível.
- **Done quando**: um ajuste sugerido pode ser testado e promovido sem editar código, com histórico.

**1.5 — Modalidade AUTOMÁTICA**
- "Ator-lead": modelo barato que interpreta perfis extraídos dos chats reais do banco e conversa sozinho com o Atendente Max em sandbox.
- Roda em lote, gera vários relatórios, agrupa os problemas mais recorrentes.
- **Done quando**: dá para rodar N simulações de uma vez e receber um relatório consolidado de onde o Atendente Max falha.

═══════════════════════════════════════
## FASE 2 — ANALISADOR PASSIVO (Camada 2)
═══════════════════════════════════════

- Job sobre conversas **finalizadas** do banco → identifica padrões (onde leads desistem, o que converte, o que esfria) → grava em `insights`.
- Relatório periódico ao CEO com sugestões; **nunca** mexe em conversa ativa; CEO aprova antes de aplicar.
- Reusa o motor de resumo/conversão que já roda. Custo baixo (Haiku).
- **Done quando**: o CEO recebe, de tempos em tempos, um diagnóstico do funil com sugestões fundamentadas em dados reais.

═══════════════════════════════════════
## FASE 3 — GERENTE ATIVO (Camada 3)
═══════════════════════════════════════

**3.1 — Sistema de notificação no CRM** *(pré-requisito estrutural)*
- Hoje não existe forma do sistema chamar o CEO (sem badge/som/push). Sem isso, o Gerente Ativo não tem como pedir aprovação.

**3.2 — Detector ao vivo**
- Avalia conversas ativas (paradas, desviadas, sinal de compra ignorado, objeção mal tratada).

**3.3 — Aprovação**
- Notifica o CEO com: o que detectou + como interviria. CEO aprova / edita / rejeita.

**3.4 — Intervenção** (canal já pronto)
- Aprovado → injeta via `POST /agent/run` (operador:true).

**3.5 — Acompanhamento**
- Verifica se o Atendente Max corrigiu o rumo → registra em `intervencoes` → volta a observador.
- **Done quando**: o Gerente Max detecta um desvio real, te chama, e (com seu ok) corrige o Atendente Max ao vivo, registrando tudo.

═══════════════════════════════════════
## TRILHA PARALELA — CORREÇÕES CRÍTICAS
═══════════════════════════════════════

Independentes dos módulos, priorizadas por risco ao negócio:
1. **Pix real** no lugar do `gerar_link_pagamento` stub (link falso na etapa de pagamento).
2. **Tratar áudio/imagem** do lead (hoje ignorados em silêncio — perda de leads).
3. **Custo IA por modelo** (corrigir o ~5x inflado).
4. **Limpeza @lid** (mesclar conversas órfãs; confirmar se `senderLid` vem nas mensagens normais para o mapa se auto-construir).

═══════════════════════════════════════
## ONDE COMEÇAR (recomendação)
═══════════════════════════════════════

Ordem sugerida, com os portões de decisão do CEO:

1. **Fase 0.1 (Sandbox) + 0.2 (schema)** — destrava tudo. É a base do Simulador e o backbone da Base de Aprendizado.
2. **Fase 1.2 (Simulador manual)** — entrega valor imediato: você testa o Atendente Max sem gastar WhatsApp, exatamente o que vem fazendo na mão, mas controlado e com relatório.
3. **Fase 1.3 + 1.4 (relatório + ciclo de aprovação versionado)** — fecha o loop de melhoria de prompt com segurança.
4. A partir daí: Analisador (Camada 2), depois Gerente Ativo (Camada 3, que exige antes o sistema de notificação).

**Decisão do CEO antes de começar:** a trilha de segurança (0.3) entra antes, em paralelo, ou fica para depois?
