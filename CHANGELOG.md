# Changelog — Vila Mundaí CRM

Registro de atualizações para acompanhar mudanças e poder voltar atrás.
Cada versão tem uma tag git de mesmo nome (ex.: `atualizacao-4.0`).

## Atualização 5.3 — 2026-06-14

Ajustes de condução (camadas/etapas, sem mexer na REGRA_PRECO):

- **Nome com rapport:** apresentar-se primeiro e só então pegar o primeiro nome
  de forma natural. Não abrir com "Com quem eu falo?" nem jogar essa pergunta
  solta depois do orçamento. (qualif / c4_qualif)
- **Grupo → categoria:** para 1, 2 ou 3 pessoas, apresentar e cotar SOMENTE o
  apartamento de 1 quarto. Só mostrar/cotar o de 2 quartos se o lead pedir um
  maior ou mais espaço. Aplicado também no orçamento. (apres+quente / c4_apres+c4_quente)

## Atualização 5.2 — 2026-06-14

Lead do site → funil próprio + IA desligada.

- Quando chega o **formulário de reserva do site** (texto estruturado "Gostaria
  de fazer uma reserva no Vila Mundaí… Detalhes da reserva: Check-in/Check-out/
  Hóspedes…"), o lead vai para o funil **"Lead do site"** e a **IA é desligada**
  (atendimento humano, com calma — não há conversa/rapport ainda, só o dado).
- Detecção `pareceSite` + `parseFormSite` em `handleIncoming`: salva nome/datas/
  hóspedes na ficha e NÃO deixa a IA disparar preço/condições.
- Novo estágio `lead_site`: seed + trigger + camada + coluna no Kanban.

## Atualização 5.1 — 2026-06-14

Volta a REGRA_PRECO 4.9 (enxuta) + ajustes de condução na apresentação e
qualificação (nas camadas/etapas, não na REGRA_PRECO, para não inchar):

- **Casal → só 1 quarto:** para 1 ou 2 pessoas, apresentar SOMENTE o apartamento
  de 1 quarto; não citar o de 2 quartos a menos que o lead peça mais espaço.
- **Pet sem over-qualify:** confirmar que aceita sem taxa e seguir; não perguntar
  porte nem quantidade.
- **Ritmo de qualificação mais leve:** sem interrogatório, sem emendar várias
  perguntas seguidas.

Aplicado em c4_apres/c4_qualif (Modelo 2) e nos prompts apres/qualif (Modelo 1).

## Atualização 5.0 — 2026-06-14

Revert: REGRA_PRECO volta à versão 4.8 (a pedido do CEO Max). Só o arquivo de
regras (src/services/stage.prompts.js) foi revertido; todo o resto (login,
dedup 9º dígito, avisos, diagnóstico Z-API) permanece. Observação: isso
reintroduz o comportamento de o Modelo 2 não se apresentar e usar preâmbulos,
que a 4.9 havia corrigido.

## Atualização 4.9 — 2026-06-14

Enxuga a REGRA_PRECO + regra de preço exato (ataca a apresentação sumida e o
preço transcrito errado no Modelo 2).

- REGRA_PRECO condensada de ~8.800 para ~4.165 chars (todas as regras mantidas,
  só o texto mais enxuto; exemplos verbosos removidos). Removido o trecho "estas
  regras valem SOBRE as instruções de etapa", que atropelava a apresentação das
  camadas (C1/C4) no Modelo 2.
- Nova regra: apresentar o preço EXATAMENTE como a ferramenta devolveu
  (total_formatado de cada opção), nunca recalcular/arredondar/trocar valores —
  corrige casos como 1Q superior saindo R$517 em vez de R$868.

Reversível: voltar para a tag atualizacao-4.8 se não ficar bom.

## Atualização 4.8 — 2026-06-14

Login real no painel + chave da API fora do HTML (etapa 1 do app no celular).

- Login com usuário/senha (`maxbgoldberg` / senha guardada como hash sha256, não
  em texto; sobrescrevível por CRM_USER/CRM_PASS_HASH no Railway).
- `POST /api/v1/auth/login` (público) devolve um token de sessão (HMAC stateless,
  30 dias, segredo AUTH_SECRET ou APP_API_KEY). `src/services/auth.js`.
- Middleware passa a aceitar `Authorization: Bearer <token>` OU `x-api-key`
  (chave mantida só para integrações servidor-a-servidor).
- Front: removida a API key embutida no HTML; agora usa o token do login
  (localStorage), entra direto se já logado, 401 derruba para o login. Tela de
  login funcional (Usuário/Senha) com Enter para entrar.

## Atualização 4.7 — 2026-06-14

A mensagem de aviso de novo lead passa a ser só o texto "Novo Lead" (sem nome,
telefone nem prévia), a pedido do dono.

## Atualização 4.6 — 2026-06-14

Aviso de novo lead no WhatsApp pessoal do dono.

- Quando um lead NOVO manda a primeira mensagem (`handleIncoming`), o dono recebe
  um WhatsApp via Z-API. Fire-and-forget, não atrasa a resposta ao lead.
- Configurável na aba Agente: número pessoal + liga/desliga (settings
  `notify_lead_phone` / `notify_lead_enabled`). Endpoints `GET/POST /notify/lead`.
- Não avisa em mensagens de operador nem se o número do aviso for o do próprio lead.

## Atualização 4.5 — 2026-06-14

Corrige duplicação de contato pelo 9º dígito (BR) e nome não gravado.

**Problema:** o WhatsApp/Z-API entrega o número ora com 13 dígitos (com o 9) ora
com 12 (sem o 9). Como o telefone é a chave de identidade, a mesma pessoa virava
2 leads e 2 conversas (ex.: Lucia/Lucia Vania, Alessandra×2). O nome (pushName)
também só era gravado na criação, nunca atualizado depois.

**Correção:**
- `lead.model`: `formasPhoneBR()` (gera as formas com/sem 9) e `findByPhoneFlex()`
  (casa o lead por qualquer forma). O número de ENVIO não muda (segurança Z-API).
- `agent.service`: `handleIncoming` usa lookup flexível, grava/atualiza o nome
  quando o pushName chega (prefere o mais completo) e funde duplicados do 9º
  dígito (`mergePhoneDuplicates` move conversas/mensagens para o lead mais antigo).
- Conversa consolidada por lead (`findOpenByLead`), não pela forma do telefone.
- `persistOutboundHuman` também usa a identidade consolidada.
- Endpoint `POST /leads/backfill-telefones` funde os duplicados já existentes.

## Atualização 4.4 — 2026-06-14

Corrige preço errado ao cotar vários tipos de uma vez (ex.: 1Q superior saindo
o dobro do térreo).

**Causa:** `consultar_disponibilidade` criava as pré-reservas temporárias de
todos os tipos em paralelo (`Promise.all`). O PMS precifica cada reserva pela
ocupação do momento, então as pré-reservas irmãs (criadas no mesmo instante)
inflavam a ocupação e contaminavam o preço umas das outras. Reproduzido: em
paralelo o 2Q saía R$750/R$1050 (errado) e as 4 reservas vinham com o mesmo
código; sequencial dava R$810/R$960 (correto).

**Correção (`src/tools/handlers.js`):** cotação SEQUENCIAL — cria, lê e cancela
uma pré-reserva por vez, só então o próximo tipo. Cada cotação enxerga só a
ocupação real. (Custa um pouco mais de tempo, mas o preço fica correto.)

## Atualização 4.3 — 2026-06-14

Funil "Reveillon" + bloqueio de cotação para datas de virada de ano.

- Datas que pegam **30 ou 31 de dezembro** → lead vai para o funil **reveillon**
  e a **IA é desligada**, sem cotar nem passar preço (condições especiais da equipe).
- Detecção em `handlers.js` (`periodoReveillon`): aplicada no `extrair_dados_lead`
  (assim que as datas aparecem) e no `consultar_disponibilidade` (bloqueia a cotação).
- Regra em REGRA_PRECO (vale nos 2 modelos): não cotar/precificar Réveillon.
- Novo estágio `reveillon`: seed + trigger + camada (lab) + coluna no Kanban.

## Atualização 4.2 — 2026-06-13

Reforço da regra de estilo: o bot estava usando travessão ("—").
- REGRA_PRECO (vale nos 2 modelos): regra explícita proibindo travessão/hífen
  para separar ideias, com exemplo certo/errado. Separar com ponto ou vírgula.

## Atualização 4.1 — 2026-06-13

Correção do preço inflado (ex.: 1Q Superior saindo R$ 6.000 em vez de R$ 1.990).

**Causa:** em `consultar_disponibilidade`, quando a cotação real (pré-reserva
temporária) de um tipo falhava (unidade ocupada/instabilidade), o código caía
num fallback que mostrava a **tarifa cheia do calendário** (`rates_and_availabilities`,
SEM desconto por ocupação). A superior tem desconto grande (cheia ~R$600 →
R$199 para casal), então o fallback gerava 600×10 = R$6.000.

**Correção (`src/tools/handlers.js`):**
- Retry (até 3x) na cotação real por tipo.
- Removido o fallback de tarifa cheia: tipo sem cotação real é **omitido**, nunca
  apresentado com a tarifa do calendário (regra de ouro: preço só da pré-reserva).
- Itens montados só com os valores do `cotarNativo` (a diária do calendário não
  vaza mais nem em caso de sucesso). Se todos falharem, retorna erro → o agente
  refaz a consulta calado.

## Atualização 4.0 — 2026-06-13

Refino do convite de pré-reserva e alinhamento da etapa Lead Quente nos dois modelos.

**REGRA_PRECO (regras de condução — valem em Modelo 1 e Modelo 2):**
- **R1 — não repetir o convite de pré-reserva:** convidar no máximo 1 vez de cada vez; se já convidou e o lead fez outra pergunta, responder só a pergunta e não reanexar o convite.
- **R2 — não emendar/forçar o CTA:** não grudar o convite no preço nem no fim de cada resposta; dar espaço para o lead responder.
- **R3 — CTA variado e sem "eu":** variar o jeito de convidar, nunca a mesma frase; não começar com "quer que eu faça a pré-reserva".
- **R4 — script de "como faz a pré-reserva":** nome completo, CPF e data de nascimento para cadastrar; depois contrato enviado por aqui; sinal de 30% para garantir, restante na chegada.

**Etapa Lead Quente (alinhada em M1 `prompt_body` e M2 `c4_quente`):**
- Exemplo de CTA trocado (sem "quer que eu… para você").
- Removido jargão do contrato ("PDF/WhatsApp/Gov.br") → "enviamos o contrato por aqui para conferir e assinar".
- Sinal corrigido: 30% Pix ou cartão em 1x (não parcelado), restante na chegada.

> Trabalho anterior a esta versão (modos Modelo 1/2, estágios sem_datas e assinatura,
> correções do contrato em PDF, regras de conduta e do sinal, anexo do contrato)
> não foi versionado; a partir do 4.0 seguimos com tags.
