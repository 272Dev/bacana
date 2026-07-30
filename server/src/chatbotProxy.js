import { z } from 'zod';
import { config, missingEnv } from './config.js';
import { requestLicenseIp, validateLicenseAccess } from './licensing.js';
import { consumeSecurityLimit } from './securityLimits.js';

const roleSchema = z.enum(['system', 'user', 'assistant']);
const messageSchema = z.object({
  role: roleSchema,
  content: z.string().trim().min(1).max(500)
}).strict();

const requestSchema = z.object({
  key: z.string().trim().min(12).max(160),
  hwid: z.string().trim().min(3).max(256),
  loaderVersion: z.string().trim().min(1).max(80).optional().default('nexus-chatbot'),
  prompt: z.string().trim().min(1).max(900),
  message: z.string().trim().min(1).max(500),
  memory: z.array(messageSchema).max(10).optional().default([]),
  maxLength: z.coerce.number().int().min(40).max(400).optional().default(200)
}).strict();

function chatBotError(message, status = 500, code = 'CHATBOT_UNAVAILABLE') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function cleanReply(value, maxLength) {
  return String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

async function authenticate(input, req) {
  const license = await validateLicenseAccess({
    key: input.key,
    hwid: input.hwid,
    loaderVersion: input.loaderVersion
  }, requestLicenseIp(req));
  await consumeSecurityLimit({
    scope: 'chatbot_response',
    subject: license.licenseUserId,
    max: 8,
    windowSeconds: 60
  });
  return license;
}

async function requestGroq(input) {
  if (missingEnv(config.chatbot.groqApiKey)) {
    throw chatBotError('ChatBot ainda nao foi configurado.', 503, 'CHATBOT_NOT_CONFIGURED');
  }
  const messages = [
    { role: 'system', content: `${input.prompt}\nResponda em portugues e respeite o limite de ${input.maxLength} caracteres.` },
    ...input.memory,
    { role: 'user', content: input.message }
  ];
  let response;
  try {
    response = await fetch(config.chatbot.groqUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.chatbot.groqApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: config.chatbot.model,
        messages,
        max_tokens: 500,
        temperature: 0.7
      }),
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    throw chatBotError('Servico de IA temporariamente indisponivel.', 502, 'CHATBOT_PROVIDER_UNAVAILABLE');
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    throw chatBotError('Servico de IA retornou uma resposta invalida.', 502, 'CHATBOT_PROVIDER_INVALID');
  }
  if (!response.ok) {
    throw chatBotError('Servico de IA recusou a solicitacao.', 502, 'CHATBOT_PROVIDER_REJECTED');
  }
  const reply = cleanReply(payload?.choices?.[0]?.message?.content, input.maxLength);
  if (!reply) throw chatBotError('Servico de IA nao retornou uma resposta.', 502, 'CHATBOT_EMPTY_RESPONSE');
  return reply;
}

export function registerChatBotRoutes(app) {
  app.post('/api/chatbot/respond', async (req, res) => {
    try {
      const input = requestSchema.parse(req.body || {});
      await authenticate(input, req);
      const response = await requestGroq(input);
      return res.json({ ok: true, response });
    } catch (error) {
      const status = Number(error?.status) || (error?.name === 'ZodError' ? 400 : 500);
      return res.status(status).json({
        ok: false,
        code: error?.code || 'CHATBOT_UNAVAILABLE',
        error: 'ChatBot indisponivel no momento.'
      });
    }
  });
}
