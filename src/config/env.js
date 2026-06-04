import dotenv from 'dotenv';
dotenv.config();

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.warn(`[env] AVISO: variável ${name} não definida.`);
  }
  return v;
}

export const env = {
  port: process.env.PORT || 3000,
  appApiKey: required('APP_API_KEY'),
  databaseUrl: required('DATABASE_URL'),

  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
    model: process.env.CLAUDE_MODEL || 'claude-opus-4-8',
    maxTokens: Number(process.env.CLAUDE_MAX_TOKENS || 1024),
  },

  zapi: {
    instanceId: required('ZAPI_INSTANCE_ID'),
    token: required('ZAPI_TOKEN'),
    clientToken: required('ZAPI_CLIENT_TOKEN'),
  },

  hospedin: {
    baseUrl: process.env.HOSPEDIN_BASE_URL || 'https://pms.hospedin.com/api/v1',
    email: process.env.HOSPEDIN_EMAIL,
    password: process.env.HOSPEDIN_PASSWORD,
    apiToken: process.env.HOSPEDIN_API_TOKEN,
  },

  propertyName: process.env.PROPERTY_NAME || 'Vila Mundaí',
};
