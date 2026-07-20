import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { db, nowIso } from './db.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { logAudit } from './audit.js';
import { requestLicenseIp, validateLicenseAccess } from './licensing.js';
import { ensureNameTagForSession } from './nameTags.js';

const SESSION_TTL_MS = 45_000;
const MAX_TICKETS = 5_000;
const loaderTickets = new Map();
const LEGACY_API_ORIGINS = [
  'https://nexus-zks.onrender.com'
];

const sessionSchema = z.object({
  key: z.string().trim().min(12).max(160),
  hwid: z.string().trim().min(3).max(256),
  loaderVersion: z.string().trim().max(80).optional().default('remote'),
  executor: z.string().trim().max(120).optional().default('unknown'),
  robloxUserId: z.string().trim().regex(/^\d{1,20}$/).optional(),
  robloxUsername: z.string().trim().max(32).optional().default(''),
  robloxDisplayName: z.string().trim().max(32).optional().default('')
});

const releaseSchema = z.object({
  version: z.string().trim().min(1).max(80),
  source: z.string().min(500).max(8_000_000),
  protectedMode: z.boolean().optional().default(false)
});

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function mapRelease(row) {
  return {
    id: row.id,
    version: row.version,
    sha256: row.payload_sha256,
    bytes: Number(row.payload_bytes || 0),
    protectedMode: Number(row.protected_mode) === 1,
    active: Number(row.active) === 1,
    createdBy: row.created_by,
    createdAt: row.created_at
  };
}

function normalizeReleaseSource(source) {
  const currentOrigin = loaderBaseUrl();
  if (!currentOrigin) return source;
  return LEGACY_API_ORIGINS.reduce(
    (normalized, legacyOrigin) => normalized.replaceAll(legacyOrigin, currentOrigin),
    source
  );
}

async function migrateReleaseOrigin(row) {
  if (!row) return null;
  const source = decryptSecret(row.payload_encrypted);
  const normalizedSource = normalizeReleaseSource(source);
  if (normalizedSource === source) return row;

  const payloadEncrypted = encryptSecret(normalizedSource);
  const payloadSha256 = hash(normalizedSource);
  const payloadBytes = Buffer.byteLength(normalizedSource, 'utf8');
  await db.prepare(`
    UPDATE loader_releases
    SET payload_encrypted = ?, payload_sha256 = ?, payload_bytes = ?
    WHERE id = ?
  `).run(payloadEncrypted, payloadSha256, payloadBytes, row.id);

  return {
    ...row,
    payload_encrypted: payloadEncrypted,
    payload_sha256: payloadSha256,
    payload_bytes: payloadBytes
  };
}

async function getActiveRelease() {
  const row = await db.prepare(`
    SELECT * FROM loader_releases WHERE active = 1 ORDER BY created_at DESC LIMIT 1
  `).get();
  return migrateReleaseOrigin(row);
}

function pruneTickets() {
  const now = Date.now();
  for (const [ticketHash, ticket] of loaderTickets) {
    if (ticket.expiresAt <= now) loaderTickets.delete(ticketHash);
  }
  if (loaderTickets.size <= MAX_TICKETS) return;
  const oldest = [...loaderTickets.entries()]
    .sort((left, right) => left[1].createdAt - right[1].createdAt)
    .slice(0, loaderTickets.size - MAX_TICKETS);
  for (const [ticketHash] of oldest) loaderTickets.delete(ticketHash);
}

function loaderBaseUrl() {
  return String(config.apiPublicUrl || '').replace(/\/$/, '');
}

function buildBootstrap() {
  const apiBase = loaderBaseUrl();
  return `-- Nexus Remote Loader | a source real nao fica nesta URL
local API=${JSON.stringify(apiBase)}
local HttpService=game:GetService("HttpService")
local Players=game:GetService("Players")
local LocalPlayer=Players.LocalPlayer
local KEY_FILE="nexus/license.key"
local DEVICE_FILE="nexus/device.id"

local function reqfn()
    if type(request)=="function" then return request end
    if type(http_request)=="function" then return http_request end
    if type(syn)=="table" and type(syn.request)=="function" then return syn.request end
    if type(fluxus)=="table" and type(fluxus.request)=="function" then return fluxus.request end
end
local function read(path) if type(readfile)=="function" then local ok,v=pcall(readfile,path);if ok then return v end end end
local function folder() if type(makefolder)=="function" then pcall(makefolder,"nexus") end end
local function write(path,value) if type(writefile)=="function" then folder();pcall(writefile,path,value) end end
local function hwid()
    if type(gethwid)=="function" then local ok,v=pcall(gethwid);if ok and v and tostring(v)~="" then return tostring(v) end end
    local ok,v=pcall(function() return game:GetService("RbxAnalyticsService"):GetClientId() end)
    if ok and v and tostring(v)~="" then return tostring(v) end
    local saved=read(DEVICE_FILE);if saved and saved~="" then return saved end
    local made=HttpService:GenerateGUID(false).."-"..tostring(LocalPlayer.UserId);write(DEVICE_FILE,made);return made
end
local function executor()
    if type(identifyexecutor)=="function" then local ok,a,b=pcall(identifyexecutor);if ok then return tostring(a or b or "unknown") end end
    if type(getexecutorname)=="function" then local ok,v=pcall(getexecutorname);if ok then return tostring(v) end end
    return "unknown"
end
local function call(method,url,body)
    local fn=reqfn()
    if fn then
        local ok,r=pcall(fn,{Url=url,Method=method,Headers={["Content-Type"]="application/json",["Accept"]="application/json"},Body=body})
        if not ok or type(r)~="table" then return nil,0 end
        return r.Body or r.body,tonumber(r.StatusCode or r.Status or r.status_code) or 0
    end
    if method=="POST" then
        local ok,r=pcall(function() return HttpService:PostAsync(url,body,Enum.HttpContentType.ApplicationJson,false) end)
        return ok and r or nil,ok and 200 or 0
    end
    local ok,r=pcall(function() return game:HttpGet(url) end);return ok and r or nil,ok and 200 or 0
end
local function start(key)
    key=tostring(key or ""):gsub("^%s+",""):gsub("%s+$",""):upper()
    if #key<12 then return nil,"Informe uma key valida." end
    local raw,status=call("POST",API.."/api/loader/session",HttpService:JSONEncode({key=key,hwid=hwid(),loaderVersion="remote-1.1",executor=executor(),robloxUserId=tostring(LocalPlayer.UserId),robloxUsername=LocalPlayer.Name,robloxDisplayName=LocalPlayer.DisplayName}))
    local ok,data=pcall(function() return HttpService:JSONDecode(raw or "{}") end)
    if not ok or type(data)~="table" then return nil,"API Nexus indisponivel." end
    if status<200 or status>=300 or not data.ok then return nil,data.error or "Licenca recusada." end
    local payload,payloadStatus=call("GET",data.payloadUrl,nil)
    if payloadStatus<200 or payloadStatus>=300 or not payload or #payload<500 then return nil,"Nao foi possivel carregar o Nexus." end
    write(KEY_FILE,key)
    _G.NEXUS_BOOTSTRAP_SESSION=data
    _G.NEXUS_BOOTSTRAP_KEY=key
    _G.NEXUS_API=API
    local fn,compileError=loadstring(payload)
    if not fn then return nil,"Payload invalido: "..tostring(compileError) end
    return fn,nil
end

local saved=rawget(_G,"NEXUS_KEY") or read(KEY_FILE)
local fn,err=start(saved)
if not fn then
    local parent=(type(gethui)=="function" and gethui()) or game:GetService("CoreGui")
    pcall(function() local old=parent:FindFirstChild("nexus_RemoteLoader");if old then old:Destroy() end end)
    local gui=Instance.new("ScreenGui");gui.Name="nexus_RemoteLoader";gui.ResetOnSpawn=false;gui.IgnoreGuiInset=true;gui.DisplayOrder=1002;gui.Parent=parent
    local panel=Instance.new("Frame");panel.AnchorPoint=Vector2.new(.5,.5);panel.Position=UDim2.fromScale(.5,.5);panel.Size=UDim2.fromOffset(360,205);panel.BackgroundColor3=Color3.fromRGB(7,7,8);panel.BorderSizePixel=0;panel.Parent=gui
    local corner=Instance.new("UICorner");corner.CornerRadius=UDim.new(0,13);corner.Parent=panel
    local border=Instance.new("UIStroke");border.Color=Color3.fromRGB(55,55,60);border.Thickness=1;border.Parent=panel
    local title=Instance.new("TextLabel");title.BackgroundTransparency=1;title.Position=UDim2.fromOffset(18,15);title.Size=UDim2.new(1,-36,0,30);title.Text="N  N E X U S";title.TextColor3=Color3.new(1,1,1);title.Font=Enum.Font.GothamBold;title.TextSize=15;title.TextXAlignment=Enum.TextXAlignment.Left;title.Parent=panel
    local input=Instance.new("TextBox");input.Position=UDim2.fromOffset(18,61);input.Size=UDim2.new(1,-36,0,42);input.BackgroundColor3=Color3.fromRGB(15,15,17);input.BorderSizePixel=0;input.PlaceholderText="NXS-XXXXX-XXXXX-XXXXX-XXXXX";input.Text=tostring(saved or "");input.TextColor3=Color3.new(1,1,1);input.PlaceholderColor3=Color3.fromRGB(105,105,112);input.Font=Enum.Font.Code;input.TextSize=12;input.ClearTextOnFocus=false;input.Parent=panel
    local ic=Instance.new("UICorner");ic.CornerRadius=UDim.new(0,8);ic.Parent=input
    local status=Instance.new("TextLabel");status.BackgroundTransparency=1;status.Position=UDim2.fromOffset(18,109);status.Size=UDim2.new(1,-36,0,24);status.Text=err or "Digite sua key.";status.TextColor3=Color3.fromRGB(145,145,152);status.Font=Enum.Font.Gotham;status.TextSize=10;status.TextXAlignment=Enum.TextXAlignment.Left;status.Parent=panel
    local button=Instance.new("TextButton");button.Position=UDim2.new(0,18,1,-56);button.Size=UDim2.new(1,-36,0,38);button.BackgroundColor3=Color3.new(1,1,1);button.BorderSizePixel=0;button.Text="VALIDAR E CARREGAR";button.TextColor3=Color3.new(0,0,0);button.Font=Enum.Font.GothamBold;button.TextSize=10;button.Parent=panel
    local bc=Instance.new("UICorner");bc.CornerRadius=UDim.new(0,8);bc.Parent=button
    local busy=false
    button.MouseButton1Click:Connect(function()
        if busy then return end;busy=true;button.Text="VALIDANDO...";status.Text="Conectando a API Nexus..."
        task.spawn(function()
            local loaded,message=start(input.Text)
            if loaded then fn=loaded;gui:Destroy() else status.Text=message or "Falha ao validar.";button.Text="TENTAR NOVAMENTE" end
            busy=false
        end)
    end)
    repeat task.wait() until fn
end
return fn()
`;
}

function sendLoaderError(res, error) {
  if (error?.code && error?.status) {
    return res.status(error.status).json({ ok: false, code: error.code, error: error.message });
  }
  throw error;
}

export function registerLoaderRoutes(app, { requireAuth, requireAdmin }) {
  app.get(['/loader/nexus.lua', '/nexus.lua'], async (_req, res) => {
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff'
    });
    res.send(buildBootstrap());
  });

  app.post('/api/loader/session', async (req, res) => {
    try {
      pruneTickets();
      const payload = sessionSchema.parse(req.body);
      const release = await getActiveRelease();
      if (!release) return res.status(503).json({ ok: false, code: 'LOADER_NOT_READY', error: 'Nenhuma versao do Nexus foi publicada.' });
      const licenseResult = await validateLicenseAccess(payload, requestLicenseIp(req));
      const nameTag = await ensureNameTagForSession(licenseResult.licenseUserId, payload);
      const token = crypto.randomBytes(32).toString('base64url');
      const createdAt = Date.now();
      loaderTickets.set(hash(token), {
        releaseId: release.id,
        licenseUserId: licenseResult.licenseUserId,
        hwidHash: hash(payload.hwid),
        executor: payload.executor,
        createdAt,
        expiresAt: createdAt + SESSION_TTL_MS
      });
      res.json({
        ok: true,
        code: 'LOADER_SESSION_VALID',
        token,
        payloadUrl: `${loaderBaseUrl()}/api/loader/payload?token=${encodeURIComponent(token)}`,
        expiresIn: Math.floor(SESSION_TTL_MS / 1000),
        release: { version: release.version, sha256: release.payload_sha256 },
        user: licenseResult.user,
        license: licenseResult.license,
        nameTag,
        serverTime: licenseResult.serverTime
      });
    } catch (error) {
      return sendLoaderError(res, error);
    }
  });

  app.get('/api/loader/payload', async (req, res) => {
    pruneTickets();
    const token = String(req.query.token || '');
    const tokenHash = hash(token);
    const ticket = token.length >= 32 ? loaderTickets.get(tokenHash) : null;
    if (!ticket || ticket.expiresAt <= Date.now()) {
      if (ticket) loaderTickets.delete(tokenHash);
      return res.status(401).type('text/plain').send('Loader token invalido ou expirado.');
    }
    loaderTickets.delete(tokenHash);
    const release = await db.prepare('SELECT * FROM loader_releases WHERE id = ? AND active = 1').get(ticket.releaseId);
    if (!release) return res.status(410).type('text/plain').send('Esta versao do loader nao esta mais ativa.');
    const storedSource = decryptSecret(release.payload_encrypted);
    if (hash(storedSource) !== release.payload_sha256) return res.status(500).type('text/plain').send('Falha de integridade do payload.');
    const source = normalizeReleaseSource(storedSource);
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'X-Nexus-Version': release.version
    });
    res.send(source);
  });

  app.get('/api/loader/releases', requireAuth, requireAdmin, async (_req, res) => {
    const rows = await db.prepare('SELECT * FROM loader_releases ORDER BY created_at DESC LIMIT 30').all();
    const base = loaderBaseUrl();
    res.json({
      releases: rows.map(mapRelease),
      bootstrapUrl: `${base}/loader/nexus.lua`,
      loadstring: `loadstring(game:HttpGet("${base}/loader/nexus.lua"))()`
    });
  });

  app.post('/api/loader/releases', requireAuth, requireAdmin, async (req, res) => {
    const payload = releaseSchema.parse(req.body);
    const normalizedSource = normalizeReleaseSource(payload.source);
    const id = crypto.randomUUID();
    const createdAt = nowIso();
    const payloadSha256 = hash(normalizedSource);
    const payloadBytes = Buffer.byteLength(normalizedSource, 'utf8');
    await db.prepare('UPDATE loader_releases SET active = 0 WHERE active = 1').run();
    await db.prepare(`
      INSERT INTO loader_releases (
        id, version, payload_encrypted, payload_sha256, payload_bytes,
        protected_mode, active, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      payload.version,
      encryptSecret(normalizedSource),
      payloadSha256,
      payloadBytes,
      payload.protectedMode ? 1 : 0,
      req.user.discordId,
      createdAt
    );
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'loader_release.created',
      targetType: 'loader_release',
      targetId: id,
      metadata: { version: payload.version, sha256: payloadSha256, bytes: payloadBytes, protectedMode: payload.protectedMode },
      ip: requestLicenseIp(req)
    });
    res.status(201).json({ release: mapRelease(await db.prepare('SELECT * FROM loader_releases WHERE id = ?').get(id)) });
  });

  app.post('/api/loader/releases/:id/activate', requireAuth, requireAdmin, async (req, res) => {
    const release = await db.prepare('SELECT * FROM loader_releases WHERE id = ?').get(req.params.id);
    if (!release) return res.status(404).json({ error: 'Versao do loader nao encontrada.' });
    await db.prepare('UPDATE loader_releases SET active = 0 WHERE active = 1').run();
    await db.prepare('UPDATE loader_releases SET active = 1 WHERE id = ?').run(release.id);
    loaderTickets.clear();
    await logAudit({ actorDiscordId: req.user.discordId, action: 'loader_release.activated', targetType: 'loader_release', targetId: release.id, ip: requestLicenseIp(req) });
    res.json({ release: mapRelease({ ...release, active: 1 }) });
  });

  app.delete('/api/loader/releases/:id', requireAuth, requireAdmin, async (req, res) => {
    const release = await db.prepare('SELECT * FROM loader_releases WHERE id = ?').get(req.params.id);
    if (!release) return res.status(404).json({ error: 'Versao do loader nao encontrada.' });
    if (Number(release.active) === 1) return res.status(409).json({ error: 'Ative outra versao antes de excluir esta.' });
    await db.prepare('DELETE FROM loader_releases WHERE id = ?').run(release.id);
    await logAudit({ actorDiscordId: req.user.discordId, action: 'loader_release.deleted', targetType: 'loader_release', targetId: release.id, metadata: { version: release.version }, ip: requestLicenseIp(req) });
    res.json({ ok: true });
  });
}
