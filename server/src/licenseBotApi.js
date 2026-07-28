import { z } from 'zod';
import { logAudit } from './audit.js';
import {
  getLicenseForDiscord,
  getLicenseHistoryForDiscord,
  isPanelPublisherAuthorized,
  redeemLicenseForDiscord,
  resetHwidForDiscord
} from './licensing.js';
import { config } from './config.js';
import * as loaderModule from './loader.js';

const discordIdSchema = z.string().trim().regex(/^\d{5,32}$/);
const redeemSchema = z.object({
  discordId: discordIdSchema,
  key: z.string().trim().min(12).max(160)
}).strict();
const selfSchema = z.object({ discordId: discordIdSchema }).strict();

function success(res, data, requestId) {
  return res.json({ success: true, requestId, ...data });
}

async function getActiveLoaderInfo() {
  if (typeof loaderModule.getActiveLoaderInfo === 'function') {
    return loaderModule.getActiveLoaderInfo();
  }
  const base = String(config.apiPublicUrl || '').replace(/\/+$/, '');
  return {
    status: 'online',
    version: null,
    publishedAt: null,
    bootstrapUrl: `${base}/loader/nexus.lua`,
    loadstring: `loadstring(game:HttpGet("${base}/loader/nexus.lua"))()`
  };
}

export function registerLicenseBotApiRoutes(app, { requireBotApiSignature }) {
  app.use('/api/bot/nexus', requireBotApiSignature);

  app.get('/api/bot/nexus/license', async (req, res) => {
    const { discordId } = selfSchema.parse(req.query);
    const license = await getLicenseForDiscord(discordId);
    await logAudit({
      actorDiscordId: discordId,
      action: 'discord_bot.license_viewed',
      targetType: 'license_user',
      targetId: license.id,
      metadata: { operationId: req.botApi.operationId }
    });
    return success(res, { license, loader: await getActiveLoaderInfo() }, req.requestId);
  });

  app.post('/api/bot/nexus/redeem', async (req, res) => {
    const payload = redeemSchema.parse(req.body);
    try {
      const license = await redeemLicenseForDiscord({
        discordId: payload.discordId,
        key: payload.key,
        source: 'discord_bot'
      });
      return success(res, { license, message: 'Key resgatada com sucesso.' }, req.requestId);
    } catch (error) {
      await logAudit({
        actorDiscordId: payload.discordId,
        action: 'discord_bot.key_redeem_failed',
        targetType: 'license_user',
        metadata: { code: error.code || 'INTERNAL_ERROR', operationId: req.botApi.operationId }
      }).catch(() => {});
      throw error;
    }
  });

  app.post('/api/bot/nexus/hwid/reset', async (req, res) => {
    const { discordId } = selfSchema.parse(req.body);
    try {
      const license = await resetHwidForDiscord({ discordId, source: 'discord_bot' });
      return success(res, {
        license,
        message: 'HWID resetado. O próximo dispositivo será vinculado no próximo uso.'
      }, req.requestId);
    } catch (error) {
      await logAudit({
        actorDiscordId: discordId,
        action: 'discord_bot.hwid_reset_failed',
        targetType: 'license_user',
        metadata: { code: error.code || 'INTERNAL_ERROR', operationId: req.botApi.operationId }
      }).catch(() => {});
      throw error;
    }
  });

  app.get('/api/bot/nexus/history', async (req, res) => {
    const { discordId } = selfSchema.parse(req.query);
    const events = await getLicenseHistoryForDiscord(discordId, 10);
    return success(res, { events }, req.requestId);
  });

  app.get('/api/bot/nexus/loader', async (req, res) => {
    const { discordId } = selfSchema.parse(req.query);
    const license = await getLicenseForDiscord(discordId);
    if (license.status !== 'active') {
      const error = new Error('Sua licença não está ativa.');
      error.status = 403;
      error.code = license.status === 'suspended' ? 'LICENSE_SUSPENDED' : 'LICENSE_EXPIRED';
      throw error;
    }
    const loader = await getActiveLoaderInfo();
    return success(res, { loader }, req.requestId);
  });

  app.get('/api/bot/nexus/panel/access', async (req, res) => {
    const { discordId } = selfSchema.parse(req.query);
    const authorized = await isPanelPublisherAuthorized(discordId);
    return success(res, { authorized }, req.requestId);
  });
}
