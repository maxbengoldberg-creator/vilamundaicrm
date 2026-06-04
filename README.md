# Vila Mundaí CRM — Backend

Agente de vendas com **Claude (tool use)** integrado a **WhatsApp (Z-API)** e ao **PMS Hospedin**, com API REST aberta e PostgreSQL. Pronto para deploy no **Railway**.

## O que ele faz

- Recebe mensagens do WhatsApp (webhook da Z-API).
- O agente "Max" (Claude) conversa, **extrai dados** (datas, hóspedes), **consulta disponibilidade no Hospedin**, **cota**, **negocia**, **cria a reserva**, **gera link de pagamento** e **move o lead no funil** — tudo via *tool use*.
- Guarda **todo o histórico** no banco, então a IA dá continuidade de onde a conversa parou.
- Escala para **atendimento humano** quando necessário (e pausa a IA naquele lead).
- Expõe uma **API REST** para o seu CRM (leads, conversas, automações).
- Tem o endpoint **`/automations/generate`**: você manda um prompt em português e a Claude devolve o **fluxo de automação em JSON** para o construtor visual.

## Estrutura

```
src/
├─ server.js              Express (entrypoint)
├─ config/                env + conexão Postgres
├─ db/                    schema.sql, migrate, seed
├─ routes/                rotas da API
├─ controllers/           webhook, agente, CRM
├─ services/              claude, zapi, hospedin, agent (loop de tool use)
├─ tools/                 definição das ferramentas + handlers
├─ models/                acesso ao banco (leads, conversas, mensagens...)
└─ middleware/            auth (x-api-key), erros
```

## Passo a passo no Railway

1. **Suba o código** num repositório no GitHub.
2. No [Railway](https://railway.app): *New Project → Deploy from GitHub repo* e escolha o repo.
3. **Adicione o PostgreSQL**: *New → Database → PostgreSQL*. O Railway cria a variável `DATABASE_URL` automaticamente e a injeta no serviço.
4. **Variáveis de ambiente** (*Settings → Variables*): copie de `.env.example` e preencha:
   - `APP_API_KEY` — invente uma chave secreta longa.
   - `ANTHROPIC_API_KEY`, `CLAUDE_MODEL` (`claude-opus-4-8`).
   - `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN`.
   - `HOSPEDIN_BASE_URL`, e (login) `HOSPEDIN_EMAIL` + `HOSPEDIN_PASSWORD` **ou** `HOSPEDIN_API_TOKEN`.
5. O deploy roda `npm run migrate && npm start` (definido em `railway.toml`) — cria as tabelas e sobe o servidor.
6. **(Opcional) Dados de exemplo:** rode uma vez `npm run seed` (via Railway *Run command* ou localmente apontando para o banco).
7. Pegue a URL pública do serviço (*Settings → Networking → Generate Domain*).

## Conectar o WhatsApp (Z-API)

No painel da Z-API → **Webhooks → "Ao receber"**, aponte para:

```
https://SEU-APP.up.railway.app/webhooks/whatsapp
```

Pronto: toda mensagem recebida aciona o agente.

## Conferir a integração do Hospedin

Os endpoints do PMS ficam **só** em `src/services/hospedin.service.js`. Abra a doc em
`https://pms.hospedin.com/api-docs` (aba *authentication*) e ajuste, se necessário:
- a rota de login (`/auth/sign_in`) e onde vem o token;
- a rota de disponibilidade (`/availabilities`) e os nomes dos parâmetros;
- a rota de reserva (`/reservations`) e o corpo.
Tudo está comentado com `>>> AJUSTE <<<`.

## API REST (todas exigem header `x-api-key: SUA_APP_API_KEY`)

| Método | Rota | Função |
|---|---|---|
| POST | `/api/v1/agent/run` | dispara o agente `{ phone, text }` |
| POST | `/api/v1/automations/generate` | `{ prompt, salvar }` → fluxo em JSON pela Claude |
| GET | `/api/v1/leads` | lista leads (`?stage=`) |
| POST | `/api/v1/leads` | cria lead |
| GET/PATCH | `/api/v1/leads/:id` | ver / atualizar lead |
| PATCH | `/api/v1/leads/:id/ai` | `{ ai_enabled }` pausa/retoma a IA |
| GET | `/api/v1/conversations` | lista conversas |
| GET | `/api/v1/conversations/:id/messages` | histórico |
| GET/PATCH | `/api/v1/automations` `/:id` | automações |

Webhook (sem api-key): `POST /webhooks/whatsapp`. Healthcheck: `GET /health`.

## Rodar localmente (opcional)

```bash
npm install
cp .env.example .env   # preencha as variáveis (DATABASE_URL de um Postgres local)
npm run migrate
npm run seed
npm run dev
```

## Custo do modelo

`claude-opus-4-8` é o mais inteligente. Para alto volume de atendimento, troque `CLAUDE_MODEL`
para `claude-sonnet-4-6` (mais barato e rápido) — basta mudar a variável, sem tocar no código.
