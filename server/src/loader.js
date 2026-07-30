import crypto from 'node:crypto';
import { z } from 'zod';
import { config } from './config.js';
import { db, nowIso } from './db.js';
import { decryptSecret, encryptedKeyId, encryptSecret } from './crypto.js';
import { logAudit } from './audit.js';
import { recordLicenseEvent, requestLicenseIp, validateLicenseAccess } from './licensing.js';
import { ensureNameTagForSession } from './nameTags.js';
import { consumeSecurityLimit, secureHash } from './securityLimits.js';
import {
  expireLoaderTickets,
  invalidateAllLoaderTickets,
  invalidateLoaderTicketsForRelease
} from './loaderTickets.js';
import {
  LUA_PROTECTION_DEFAULTS,
  MAX_LUA_SOURCE_BYTES,
  MIN_LUA_SOURCE_BYTES,
  protectLuaSource,
  validateLuaUpload
} from './luaProtection.js';
import { assertLoaderTicketEligible } from './loaderPolicy.js';

const SESSION_TTL_MS = 45_000;
const MAX_SOURCE_BYTES = MAX_LUA_SOURCE_BYTES;
const MIN_SOURCE_BYTES = MIN_LUA_SOURCE_BYTES;
const noControlCharacters = (value) => !/[\u0000-\u001F\u007F]/.test(value);

const sessionSchema = z.object({
  key: z.string().trim().min(12).max(160),
  hwid: z.string().trim().min(3).max(256).refine(noControlCharacters),
  loaderVersion: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/).default('remote'),
  executor: z.string().trim().min(1).max(120).refine(noControlCharacters).default('unknown'),
  robloxUserId: z.string().trim().regex(/^\d{1,20}$/),
  robloxUsername: z.string().trim().regex(/^[A-Za-z0-9_]{3,20}$/),
  robloxDisplayName: z.string().trim().min(1).max(32).refine(noControlCharacters),
  requestNonce: z.string().trim().regex(/^[A-Za-z0-9_-]{16,120}$/),
  timestamp: z.coerce.number().int().positive()
}).strict();

const payloadSchema = z.object({
  token: z.string().trim().min(32).max(256),
  hwid: z.string().trim().min(3).max(256).refine(noControlCharacters),
  requestNonce: z.string().trim().regex(/^[A-Za-z0-9_-]{16,120}$/),
  robloxUserId: z.string().trim().regex(/^\d{1,20}$/),
  releaseVersion: z.string().trim().min(1).max(80)
}).strict();

const protectionSchema = z.object({
  level: z.enum(['basic', 'normal', 'strong']).default(LUA_PROTECTION_DEFAULTS.level),
  removeComments: z.boolean().default(LUA_PROTECTION_DEFAULTS.removeComments),
  renameLocalVariables: z.boolean().default(LUA_PROTECTION_DEFAULTS.renameLocalVariables),
  renameLocalFunctions: z.boolean().default(LUA_PROTECTION_DEFAULTS.renameLocalFunctions),
  protectStrings: z.boolean().default(LUA_PROTECTION_DEFAULTS.protectStrings),
  protectConstants: z.boolean().default(LUA_PROTECTION_DEFAULTS.protectConstants),
  transformControlFlow: z.boolean().default(LUA_PROTECTION_DEFAULTS.transformControlFlow),
  addVersionMark: z.boolean().default(LUA_PROTECTION_DEFAULTS.addVersionMark),
  syntaxCheck: z.literal(true).default(true),
  loadTest: z.literal(true).default(true),
  activateImmediately: z.boolean().default(LUA_PROTECTION_DEFAULTS.activateImmediately)
}).default(LUA_PROTECTION_DEFAULTS);

const releaseSchema = z.object({
  version: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/, 'Versão inválida.'),
  fileName: z.string().trim().regex(/^[^\\/:*?"<>|\u0000-\u001F]{1,180}\.lua$/i, 'Selecione um arquivo .lua válido.'),
  source: z.string().min(1).max(MAX_SOURCE_BYTES),
  protection: protectionSchema.optional(),
  protectedMode: z.boolean().optional()
}).strict();

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(String(value || '')) || fallback;
  } catch {
    return fallback;
  }
}

function makeLoaderError(message, status, code, details = undefined) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.details = details;
  return error;
}

function mapRelease(row) {
  const validation = parseJson(row.validation_json, {});
  return {
    id: row.id,
    version: row.version,
    sha256: row.protected_sha256 || row.payload_sha256,
    originalSha256: row.original_sha256 || row.payload_sha256,
    protectedSha256: row.protected_sha256 || row.payload_sha256,
    encryptedSha256: row.encrypted_sha256 || null,
    bytes: Number(row.protected_bytes || row.payload_bytes || 0),
    originalBytes: Number(row.original_bytes || row.payload_bytes || 0),
    protectedBytes: Number(row.protected_bytes || row.payload_bytes || 0),
    protectionLevel: row.protection_level || (Number(row.protected_mode) === 1 ? 'normal' : 'basic'),
    protectionOptions: parseJson(row.protection_options_json, {}),
    encryptionKeyId: row.encryption_key_id || 'legacy-v1',
    syntaxValid: Number(row.syntax_valid) === 1,
    validation,
    processingMs: Number(row.processing_ms || 0),
    active: Number(row.active) === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at || row.created_at
  };
}

async function getActiveRelease(store = db) {
  return store.prepare(`
    SELECT * FROM loader_releases WHERE active = 1 ORDER BY created_at DESC LIMIT 1
  `).get();
}

function loaderBaseUrl() {
  return String(config.apiPublicUrl || '').replace(/\/$/, '');
}

export async function getActiveLoaderInfo() {
  const release = await getActiveRelease();
  const base = loaderBaseUrl();
  return {
    status: release ? 'online' : 'unavailable',
    version: release?.version || null,
    publishedAt: release?.created_at || null,
    bootstrapUrl: `${base}/loader/nexus.lua`,
    loadstring: `loadstring(game:HttpGet("${base}/loader/nexus.lua"))()`
  };
}

function buildBootstrap() {
  const apiBase = loaderBaseUrl();
  return `-- Nexus Remote Loader
local API=${JSON.stringify(apiBase)}
local HttpService=game:GetService("HttpService")
local Players=game:GetService("Players")
local LocalPlayer=Players.LocalPlayer
local KEY_FILE="nexus/license.key"
local DEVICE_FILE="nexus/device.id"
local MESSAGES={
IDLE="Pronto para validar.",
CHECKING_KEY="Verificando licença...",
CHECKING_DEVICE="Validando dispositivo...",
CHECKING_VERSION="Verificando versão...",
REQUESTING_TICKET="Solicitando acesso temporário...",
DOWNLOADING="Baixando conteúdo autorizado...",
VERIFYING="Verificando integridade...",
LOADING="Carregando Nexus...",
SUCCESS="Nexus carregado.",
ERROR="Falha temporária no servidor.",
SUSPENDED="Esta licença está suspensa.",
EXPIRED="Esta licença expirou.",
HWID_MISMATCH="Este dispositivo não corresponde ao HWID vinculado."
}
local NexusStatus={state="IDLE",message=MESSAGES.IDLE,label=nil}
function NexusStatus:SetState(state,message)
    self.state=state
    self.message=message or MESSAGES[state] or MESSAGES.ERROR
    if self.label then
        self.label.Text=self.message
        self.label.TextColor3=(state=="ERROR" or state=="SUSPENDED" or state=="EXPIRED" or state=="HWID_MISMATCH") and Color3.fromRGB(235,235,235) or Color3.fromRGB(155,155,162)
    end
end
local function requestFunction()
    if type(request)=="function" then return request end
    if type(http_request)=="function" then return http_request end
    if type(syn)=="table" and type(syn.request)=="function" then return syn.request end
    if type(fluxus)=="table" and type(fluxus.request)=="function" then return fluxus.request end
end
local function safeRead(path)
    if type(readfile)~="function" then return nil end
    local ok,value=pcall(readfile,path)
    return ok and value or nil
end
local function ensureFolder()
    if type(makefolder)=="function" then pcall(makefolder,"nexus") end
end
local function safeWrite(path,value)
    if type(writefile)~="function" then return false end
    ensureFolder()
    return pcall(writefile,path,value)
end
local function safeDelete(path)
    if type(delfile)=="function" then
        local ok=pcall(delfile,path)
        if ok then return true end
    end
    if type(writefile)=="function" then return pcall(writefile,path,"") end
    return false
end
local function normalizeKey(value)
    local compact=tostring(value or ""):upper():gsub("%s+","-"):gsub("_","-"):gsub("%-+","-"):gsub("^%-",""):gsub("%-$","")
    local raw=compact:gsub("%-","")
    if #raw==23 and raw:sub(1,3)=="NXS" then
        compact="NXS-"..raw:sub(4,8).."-"..raw:sub(9,13).."-"..raw:sub(14,18).."-"..raw:sub(19,23)
    end
    return compact
end
local function validKey(value)
    return normalizeKey(value):match("^NXS%-[A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9]%-[A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9]%-[A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9]%-[A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9][A-Z2-9]$")~=nil
end
local function loadSavedKey()
    local value=safeRead(KEY_FILE)
    return validKey(value) and normalizeKey(value) or nil
end
local function saveKey(value)
    value=normalizeKey(value)
    return validKey(value) and safeWrite(KEY_FILE,value) or false
end
local function deleteSavedKey()
    safeDelete(KEY_FILE)
end
local function maskKey(value)
    value=normalizeKey(value)
    if #value<12 then return "Nenhuma key salva" end
    return value:sub(1,9).."•••••"..value:sub(-5)
end
local function deviceId()
    NexusStatus:SetState("CHECKING_DEVICE")
    if type(gethwid)=="function" then
        local ok,value=pcall(gethwid)
        if ok and value and tostring(value)~="" then return tostring(value):lower() end
    end
    local ok,value=pcall(function() return game:GetService("RbxAnalyticsService"):GetClientId() end)
    if ok and value and tostring(value)~="" then return tostring(value):lower() end
    local saved=safeRead(DEVICE_FILE)
    if saved and saved~="" then return tostring(saved):lower() end
    local generated=HttpService:GenerateGUID(false).."-"..tostring(LocalPlayer.UserId)
    safeWrite(DEVICE_FILE,generated)
    return generated:lower()
end
local function executorName()
    if type(identifyexecutor)=="function" then
        local ok,a,b=pcall(identifyexecutor)
        if ok then return tostring(a or b or "unknown"):sub(1,120) end
    end
    if type(getexecutorname)=="function" then
        local ok,value=pcall(getexecutorname)
        if ok then return tostring(value):sub(1,120) end
    end
    return "unknown"
end
local function apiCall(method,path,payload)
    local body=payload and HttpService:JSONEncode(payload) or nil
    local fn=requestFunction()
    if fn then
        local ok,response=pcall(fn,{Url=API..path,Method=method,Headers={["Content-Type"]="application/json",["Accept"]="application/json"},Body=body})
        if not ok or type(response)~="table" then return nil,0 end
        return response.Body or response.body,tonumber(response.StatusCode or response.Status or response.status_code) or 0
    end
    if method=="POST" then
        local ok,response=pcall(function() return HttpService:PostAsync(API..path,body or "{}",Enum.HttpContentType.ApplicationJson,false) end)
        return ok and response or nil,ok and 200 or 0
    end
    local ok,response=pcall(function() return game:HttpGet(API..path) end)
    return ok and response or nil,ok and 200 or 0
end
local function decodeJson(raw)
    local ok,value=pcall(function() return HttpService:JSONDecode(raw or "{}") end)
    return ok and type(value)=="table" and value or nil
end
local function stateForCode(code)
    if code=="LICENSE_SUSPENDED" or code=="SUSPICIOUS_SHARING" or code=="SUSPICIOUS_NETWORK" then return "SUSPENDED" end
    if code=="LICENSE_EXPIRED" then return "EXPIRED" end
    if code=="HWID_MISMATCH" then return "HWID_MISMATCH" end
    return "ERROR"
end
local function optionalSha256(value)
    local candidates={
        type(crypt)=="table" and crypt.hash,
        type(syn)=="table" and type(syn.crypt)=="table" and syn.crypt.hash,
        type(crypto)=="table" and crypto.hash
    }
    for _,candidate in ipairs(candidates) do
        if type(candidate)=="function" then
            local ok,result=pcall(candidate,value,"sha256")
            if ok and type(result)=="string" then return result:lower() end
        end
    end
    return nil
end
local function start(key)
    NexusStatus:SetState("CHECKING_KEY")
    key=normalizeKey(key)
    if not validKey(key) then return nil,"ERROR","Informe uma key Nexus válida." end
    local hwid=deviceId()
    NexusStatus:SetState("CHECKING_VERSION")
    local nonce=HttpService:GenerateGUID(false)..HttpService:GenerateGUID(false)
    NexusStatus:SetState("REQUESTING_TICKET")
    local raw,status=apiCall("POST","/api/loader/session",{
        key=key,hwid=hwid,loaderVersion="remote-2.0",executor=executorName(),
        robloxUserId=tostring(LocalPlayer.UserId),robloxUsername=LocalPlayer.Name,
        robloxDisplayName=LocalPlayer.DisplayName,requestNonce=nonce,timestamp=os.time()
    })
    local data=decodeJson(raw)
    if not data or status<200 or status>=300 or data.success==false then
        local code=data and data.code or "INTERNAL_ERROR"
        if code=="KEY_INVALID" or code=="INVALID_KEY" then deleteSavedKey() end
        return nil,stateForCode(code),(data and data.message) or MESSAGES.ERROR
    end
    NexusStatus:SetState("DOWNLOADING")
    local payloadRaw,payloadStatus=apiCall("POST","/api/loader/payload",{
        token=data.token,hwid=hwid,requestNonce=nonce,robloxUserId=tostring(LocalPlayer.UserId),
        releaseVersion=data.release.version
    })
    if payloadStatus<200 or payloadStatus>=300 or not payloadRaw or #payloadRaw<${MIN_SOURCE_BYTES} then
        local failure=decodeJson(payloadRaw)
        return nil,"ERROR",(failure and failure.message) or "O acesso temporário expirou. Tente novamente."
    end
    NexusStatus:SetState("VERIFYING")
    local calculated=optionalSha256(payloadRaw)
    if calculated and calculated~=tostring(data.release.sha256):lower() then
        return nil,"ERROR","A verificação de integridade falhou."
    end
    NexusStatus:SetState("LOADING")
    local compiled,compileError=loadstring(payloadRaw)
    if not compiled then return nil,"ERROR","O conteúdo autorizado não pôde ser carregado." end
    saveKey(key)
    _G.NEXUS_BOOTSTRAP_SESSION={release=data.release,license=data.license,user=data.user,nameTag=data.nameTag}
    _G.NEXUS_BOOTSTRAP_KEY=key
    _G.NEXUS_API=API
    NexusStatus:SetState("SUCCESS")
    return compiled,nil,nil
end
local saved=rawget(_G,"NEXUS_KEY") or loadSavedKey()
local compiled,errorState,errorMessage=start(saved)
if not compiled then
    local parent=(type(gethui)=="function" and gethui()) or game:GetService("CoreGui")
    pcall(function() local old=parent:FindFirstChild("nexus_RemoteLoader");if old then old:Destroy() end end)
    local gui=Instance.new("ScreenGui");gui.Name="nexus_RemoteLoader";gui.ResetOnSpawn=false;gui.IgnoreGuiInset=true;gui.DisplayOrder=1002;gui.Parent=parent
    local panel=Instance.new("Frame");panel.AnchorPoint=Vector2.new(.5,.5);panel.Position=UDim2.fromScale(.5,.5);panel.Size=UDim2.fromOffset(374,228);panel.BackgroundColor3=Color3.fromRGB(8,8,9);panel.BorderSizePixel=0;panel.Parent=gui
    Instance.new("UICorner",panel).CornerRadius=UDim.new(0,16)
    local border=Instance.new("UIStroke",panel);border.Color=Color3.fromRGB(62,62,66);border.Thickness=1
    local title=Instance.new("TextLabel",panel);title.BackgroundTransparency=1;title.Position=UDim2.fromOffset(20,17);title.Size=UDim2.new(1,-40,0,28);title.Text="N  N E X U S";title.TextColor3=Color3.new(1,1,1);title.Font=Enum.Font.GothamBold;title.TextSize=15;title.TextXAlignment=Enum.TextXAlignment.Left
    local savedLabel=Instance.new("TextLabel",panel);savedLabel.BackgroundTransparency=1;savedLabel.Position=UDim2.fromOffset(20,45);savedLabel.Size=UDim2.new(1,-40,0,18);savedLabel.Text=maskKey(saved);savedLabel.TextColor3=Color3.fromRGB(118,118,124);savedLabel.Font=Enum.Font.Code;savedLabel.TextSize=10;savedLabel.TextXAlignment=Enum.TextXAlignment.Left
    local input=Instance.new("TextBox",panel);input.Position=UDim2.fromOffset(20,72);input.Size=UDim2.new(1,-40,0,43);input.BackgroundColor3=Color3.fromRGB(16,16,18);input.BorderSizePixel=0;input.PlaceholderText="NXS-XXXXX-XXXXX-XXXXX-XXXXX";input.Text="";input.TextColor3=Color3.new(1,1,1);input.PlaceholderColor3=Color3.fromRGB(100,100,106);input.Font=Enum.Font.Code;input.TextSize=12;input.ClearTextOnFocus=false
    Instance.new("UICorner",input).CornerRadius=UDim.new(0,9)
    local statusLabel=Instance.new("TextLabel",panel);statusLabel.BackgroundTransparency=1;statusLabel.Position=UDim2.fromOffset(20,121);statusLabel.Size=UDim2.new(1,-40,0,34);statusLabel.TextWrapped=true;statusLabel.Text=errorMessage or MESSAGES.IDLE;statusLabel.TextColor3=Color3.fromRGB(155,155,162);statusLabel.Font=Enum.Font.Gotham;statusLabel.TextSize=10;statusLabel.TextXAlignment=Enum.TextXAlignment.Left;statusLabel.TextYAlignment=Enum.TextYAlignment.Top
    NexusStatus.label=statusLabel;NexusStatus:SetState(errorState or "IDLE",errorMessage)
    local button=Instance.new("TextButton",panel);button.Position=UDim2.new(0,20,1,-57);button.Size=UDim2.new(1,-40,0,38);button.BackgroundColor3=Color3.new(1,1,1);button.BorderSizePixel=0;button.Text="VALIDAR E CARREGAR";button.TextColor3=Color3.new(0,0,0);button.Font=Enum.Font.GothamBold;button.TextSize=10
    Instance.new("UICorner",button).CornerRadius=UDim.new(0,9)
    local busy=false
    button.MouseButton1Click:Connect(function()
        if busy then return end
        busy=true;button.Active=false;button.Text="VERIFICANDO..."
        task.spawn(function()
            local loaded,state,message=start(input.Text)
            if loaded then compiled=loaded;gui:Destroy()
            else NexusStatus:SetState(state or "ERROR",message);button.Text="TENTAR NOVAMENTE";button.Active=true end
            busy=false
        end)
    end)
    repeat task.wait() until compiled
end
local ok,result=pcall(compiled)
if not ok then error("Nexus não pôde ser iniciado.",0) end
return result
`;
}

async function recordTicketEvent(licenseUserId, type, metadata = {}) {
  await recordLicenseEvent(licenseUserId, type, {
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value != null))
  }).catch(() => {});
}

async function consumeTicket(input) {
  const ticketHash = secureHash(input.token, 'loader-ticket');
  const hwidHash = secureHash(input.hwid.trim().toLowerCase(), 'loader-hwid');
  const nonceHash = secureHash(input.requestNonce, 'loader-nonce');
  const outcome = await db.transaction(async (tx) => {
    const ticket = await tx.prepare(`
      SELECT lt.*, lr.version, lr.active, lr.payload_encrypted, lr.payload_sha256,
        lr.protected_sha256, lu.status AS license_status, lu.expires_at AS license_expires_at
      FROM loader_tickets lt
      JOIN loader_releases lr ON lr.id = lt.release_id
      JOIN license_users lu ON lu.id = lt.license_user_id
      WHERE lt.ticket_hash = ?
    `).get(ticketHash);
    if (!ticket) {
      return { error: makeLoaderError('Ticket inválido.', 401, 'TICKET_INVALID') };
    }
    await tx.prepare('UPDATE loader_tickets SET attempts = attempts + 1 WHERE id = ?').run(ticket.id);
    const current = await tx.prepare('SELECT attempts FROM loader_tickets WHERE id = ?').get(ticket.id);
    ticket.attempts = Number(current?.attempts || Number(ticket.attempts || 0) + 1);
    try {
      assertLoaderTicketEligible(ticket, {
        releaseVersion: input.releaseVersion,
        hwidHash,
        nonceHash,
        robloxUserId: input.robloxUserId
      }, {
        maxAttempts: config.loader.rateLimits.ticketConsumeAttempts
      });
    } catch (error) {
      error.internalTicketId = ticket.id;
      error.internalLicenseUserId = ticket.license_user_id;
      return { error };
    }
    const updated = await tx.prepare(`
      UPDATE loader_tickets SET used = 1, used_at = ?
      WHERE id = ? AND used = 0 AND invalidated_at IS NULL AND expires_at > ?
        AND hwid_hash = ? AND nonce_hash = ? AND release_id = ?
    `).run(nowIso(), ticket.id, nowIso(), hwidHash, nonceHash, ticket.release_id);
    if (Number(updated.changes || 0) !== 1) {
      const error = makeLoaderError('Este ticket já foi utilizado ou expirou.', 409, 'TICKET_USED');
      error.internalTicketId = ticket.id;
      error.internalLicenseUserId = ticket.license_user_id;
      return { error };
    }
    return { ticket };
  });
  if (outcome.error) throw outcome.error;
  return outcome.ticket;
}

function sendLoaderError(res, error, requestId) {
  const status = Number(error?.status || 500);
  const code = error?.code || 'INTERNAL_ERROR';
  const safeMessage = status >= 500 ? 'Falha temporária no servidor.' : error.message;
  return res.status(status).json({
    success: false,
    code,
    message: safeMessage,
    requestId,
    retryAfterSeconds: error?.retryAfterSeconds,
    details: code === 'LUA_SYNTAX_INVALID' || code === 'LUA_PROTECTION_INVALID' ? error.details || error.validation : undefined
  });
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
    const requestId = req.requestId || crypto.randomUUID();
    try {
      await expireLoaderTickets();
      const payload = sessionSchema.parse(req.body);
      if (Math.abs(Date.now() - payload.timestamp * 1000) > 5 * 60_000) {
        throw makeLoaderError('A solicitação está fora da janela permitida.', 400, 'REQUEST_EXPIRED');
      }
      const release = await getActiveRelease();
      if (!release) throw makeLoaderError('Nenhuma versão do Nexus está disponível.', 503, 'LOADER_NOT_READY');
      const licenseResult = await validateLicenseAccess(payload, requestLicenseIp(req));
      await consumeSecurityLimit({
        scope: 'loader_ticket',
        subject: licenseResult.licenseUserId,
        max: config.loader.rateLimits.tickets,
        windowSeconds: config.loader.rateLimits.ticketWindowSeconds
      });
      const nameTag = await ensureNameTagForSession(licenseResult.licenseUserId, payload);
      const token = crypto.randomBytes(32).toString('base64url');
      const ticketHash = secureHash(token, 'loader-ticket');
      const nonceHash = secureHash(payload.requestNonce, 'loader-nonce');
      const hwidHash = secureHash(payload.hwid.trim().toLowerCase(), 'loader-hwid');
      const createdAt = nowIso();
      const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
      try {
        await db.prepare(`
          INSERT INTO loader_tickets (
            id, ticket_hash, license_user_id, release_id, hwid_hash,
            roblox_user_id, nonce_hash, executor, used, attempts,
            created_at, expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
        `).run(
          crypto.randomUUID(), ticketHash, licenseResult.licenseUserId, release.id,
          hwidHash, payload.robloxUserId, nonceHash, payload.executor, createdAt, expiresAt
        );
      } catch {
        throw makeLoaderError('Esta solicitação já foi utilizada.', 409, 'REQUEST_REPLAYED');
      }
      await recordTicketEvent(licenseResult.licenseUserId, 'loader_ticket_created', {
        version: release.version
      });
      res.json({
        success: true,
        code: 'LOADER_SESSION_VALID',
        requestId,
        token,
        expiresIn: Math.floor(SESSION_TTL_MS / 1000),
        release: { version: release.version, sha256: release.protected_sha256 || release.payload_sha256 },
        user: licenseResult.user,
        license: licenseResult.license,
        nameTag,
        serverTime: licenseResult.serverTime
      });
    } catch (error) {
      await logAudit({
        action: 'loader.session_rejected',
        targetType: 'loader_session',
        metadata: { requestId, code: error.code || 'INTERNAL_ERROR' }
      }).catch(() => {});
      return sendLoaderError(res, error, requestId);
    }
  });

  app.post('/api/loader/payload', async (req, res) => {
    const requestId = req.requestId || crypto.randomUUID();
    try {
      const input = payloadSchema.parse(req.body);
      const ticket = await consumeTicket(input);
      let source;
      try {
        source = decryptSecret(ticket.payload_encrypted);
      } catch {
        await logAudit({
          action: 'loader.integrity_error',
          targetType: 'loader_release',
          targetId: ticket.release_id,
          metadata: { requestId, stage: 'decrypt' }
        });
        throw makeLoaderError('Falha de integridade da versão.', 500, 'VERSION_INTEGRITY_ERROR');
      }
      const expectedHash = ticket.protected_sha256 || ticket.payload_sha256;
      if (sha256(source) !== expectedHash) {
        await logAudit({
          action: 'loader.integrity_error',
          targetType: 'loader_release',
          targetId: ticket.release_id,
          metadata: { requestId, stage: 'sha256' }
        });
        throw makeLoaderError('Falha de integridade da versão.', 500, 'VERSION_INTEGRITY_ERROR');
      }
      await recordTicketEvent(ticket.license_user_id, 'loader_ticket_used', {
        version: ticket.version
      });
      res.set({
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate, private',
        Pragma: 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'X-Nexus-Version': ticket.version,
        'X-Request-Id': requestId
      });
      res.send(source);
    } catch (error) {
      await logAudit({
        action: 'loader.ticket_rejected',
        targetType: 'loader_ticket',
        targetId: error.internalTicketId || null,
        metadata: { requestId, code: error.code || 'INTERNAL_ERROR' }
      }).catch(() => {});
      if (error.internalLicenseUserId) {
        await recordTicketEvent(error.internalLicenseUserId, 'loader_ticket_rejected', {
          code: error.code || 'INTERNAL_ERROR'
        });
      }
      return sendLoaderError(res, error, requestId);
    }
  });

  app.get('/api/loader/releases', requireAuth, requireAdmin, async (_req, res) => {
    const rows = await db.prepare('SELECT * FROM loader_releases ORDER BY created_at DESC LIMIT 30').all();
    res.json({ releases: rows.map(mapRelease), ...(await getActiveLoaderInfo()) });
  });

  app.post('/api/loader/releases', requireAuth, requireAdmin, async (req, res) => {
    const payload = releaseSchema.parse(req.body);
    validateLuaUpload(payload.fileName, payload.source);
    const protectionInput = payload.protection || {
      ...LUA_PROTECTION_DEFAULTS,
      level: payload.protectedMode === false ? 'basic' : LUA_PROTECTION_DEFAULTS.level
    };
    const processed = protectLuaSource(payload.source, { ...protectionInput, version: payload.version });
    const encrypted = encryptSecret(processed.source);
    if (decryptSecret(encrypted) !== processed.source) {
      throw makeLoaderError('A verificação da cifragem falhou.', 500, 'ENCRYPTION_FAILED');
    }
    const id = crypto.randomUUID();
    const timestamp = nowIso();
    const encryptedSha256 = sha256(encrypted);
    const row = await db.transaction(async (tx) => {
      await tx.prepare(`
        INSERT INTO loader_releases (
          id, version, payload_encrypted, payload_sha256, payload_bytes,
          protected_mode, original_sha256, protected_sha256, encrypted_sha256,
          original_bytes, protected_bytes, protection_level, protection_options_json,
          encryption_key_id, syntax_valid, validation_json, processing_ms,
          active, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?)
      `).run(
        id, payload.version, encrypted, processed.protectedSha256, processed.protectedBytes,
        processed.originalSha256, processed.protectedSha256, encryptedSha256,
        processed.originalBytes, processed.protectedBytes, processed.options.level,
        JSON.stringify(processed.options), encryptedKeyId(encrypted),
        JSON.stringify(processed.validation), processed.processingMs,
        req.user.discordId, timestamp, timestamp
      );
      if (processed.options.activateImmediately) {
        await tx.prepare('UPDATE loader_releases SET active = 0, updated_at = ? WHERE active = 1').run(timestamp);
        await tx.prepare('UPDATE loader_releases SET active = 1, updated_at = ? WHERE id = ?').run(timestamp, id);
        await invalidateAllLoaderTickets('release_published', tx);
      }
      return tx.prepare('SELECT * FROM loader_releases WHERE id = ?').get(id);
    });
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'loader_release.created',
      targetType: 'loader_release',
      targetId: id,
      metadata: {
        version: payload.version,
        fileName: payload.fileName,
        originalSha256: processed.originalSha256,
        protectedSha256: processed.protectedSha256,
        originalBytes: processed.originalBytes,
        protectedBytes: processed.protectedBytes,
        protectionLevel: processed.options.level,
        activated: processed.options.activateImmediately
      },
      ip: requestLicenseIp(req)
    });
    res.status(201).json({ release: mapRelease(row) });
  });

  app.post('/api/loader/releases/:id/activate', requireAuth, requireAdmin, async (req, res) => {
    const release = await db.transaction(async (tx) => {
      const selected = await tx.prepare('SELECT * FROM loader_releases WHERE id = ?').get(req.params.id);
      if (!selected) throw makeLoaderError('Versão do loader não encontrada.', 404, 'VERSION_NOT_FOUND');
      let selectedSource;
      try {
        selectedSource = decryptSecret(selected.payload_encrypted);
      } catch {
        throw makeLoaderError('A versão selecionada falhou na verificação de integridade.', 409, 'VERSION_INTEGRITY_ERROR');
      }
      if (sha256(selectedSource) !== (selected.protected_sha256 || selected.payload_sha256)) {
        throw makeLoaderError('A versão selecionada falhou na verificação de integridade.', 409, 'VERSION_INTEGRITY_ERROR');
      }
      const timestamp = nowIso();
      await tx.prepare('UPDATE loader_releases SET active = 0, updated_at = ? WHERE active = 1').run(timestamp);
      await tx.prepare('UPDATE loader_releases SET active = 1, updated_at = ? WHERE id = ?').run(timestamp, selected.id);
      await invalidateAllLoaderTickets('release_activated', tx);
      return tx.prepare('SELECT * FROM loader_releases WHERE id = ?').get(selected.id);
    });
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'loader_release.activated',
      targetType: 'loader_release',
      targetId: release.id,
      ip: requestLicenseIp(req)
    });
    res.json({ release: mapRelease(release) });
  });

  app.delete('/api/loader/releases/:id', requireAuth, requireAdmin, async (req, res) => {
    const release = await db.transaction(async (tx) => {
      const selected = await tx.prepare('SELECT * FROM loader_releases WHERE id = ?').get(req.params.id);
      if (!selected) throw makeLoaderError('Versão do loader não encontrada.', 404, 'VERSION_NOT_FOUND');
      if (Number(selected.active) === 1) {
        throw makeLoaderError('Ative outra versão antes de excluir esta.', 409, 'VERSION_ACTIVE');
      }
      await invalidateLoaderTicketsForRelease(selected.id, 'release_deleted', tx);
      const removed = await tx.prepare('DELETE FROM loader_releases WHERE id = ? AND active = 0').run(selected.id);
      if (Number(removed.changes || 0) !== 1) {
        throw makeLoaderError('A versão ativa não pode ser excluída.', 409, 'VERSION_ACTIVE');
      }
      return selected;
    });
    await logAudit({
      actorDiscordId: req.user.discordId,
      action: 'loader_release.deleted',
      targetType: 'loader_release',
      targetId: release.id,
      metadata: { version: release.version },
      ip: requestLicenseIp(req)
    });
    res.json({ success: true });
  });
}
