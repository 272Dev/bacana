const CATEGORY_LABELS = Object.freeze({
  messages: 'Mensagens',
  links: 'Links',
  files: 'Arquivos',
  profiles: 'Perfis',
  raids: 'Raids',
  channels: 'Canais',
  roles: 'Cargos',
  members: 'Membros',
  webhooks: 'Webhooks',
  server: 'Servidor',
  voice: 'Voz',
  threads: 'Threads',
  assets: 'Emojis e stickers',
  antinuke: 'Anti-nuke'
});

function detector(id, label, category, options = {}) {
  return Object.freeze({
    id,
    label,
    category,
    source: options.source || category,
    defaultEnabled: options.defaultEnabled !== false,
    defaultThreshold: Number(options.threshold || 1),
    defaultWindowSeconds: Number(options.windowSeconds || 60),
    defaultPunishment: options.punishment || (['messages', 'links', 'files', 'profiles', 'voice'].includes(category) ? 'timeout' : 'remove_roles'),
    deleteMessage: Boolean(options.deleteMessage),
    capability: options.capability || 'native',
    severity: options.severity || 'high'
  });
}

export const DETECTOR_CATEGORIES = CATEGORY_LABELS;

export const DETECTOR_CATALOG = Object.freeze([
  detector('spam', 'Spam Detection', 'messages', { threshold: 8, windowSeconds: 15, deleteMessage: true }),
  detector('flood', 'Flood Detection', 'messages', { threshold: 12, windowSeconds: 30, deleteMessage: true }),
  detector('fast_message_spam', 'Fast Message Spam', 'messages', { threshold: 5, windowSeconds: 4, deleteMessage: true }),
  detector('duplicate_message', 'Duplicate Message Detection', 'messages', { threshold: 4, windowSeconds: 25, deleteMessage: true }),
  detector('similar_message', 'Similar Message Detection', 'messages', { threshold: 3, windowSeconds: 30, deleteMessage: true, capability: 'heuristic' }),
  detector('copy_paste_spam', 'Copy/Paste Spam', 'messages', { threshold: 3, windowSeconds: 45, deleteMessage: true }),
  detector('excessive_character', 'Excessive Character Spam', 'messages', { threshold: 14, deleteMessage: true }),
  detector('repeated_word', 'Repeated Word Spam', 'messages', { threshold: 8, deleteMessage: true }),
  detector('excessive_caps', 'Excessive Caps Detection', 'messages', { threshold: 75, deleteMessage: true, severity: 'medium' }),
  detector('excessive_emoji', 'Excessive Emoji Detection', 'messages', { threshold: 14, deleteMessage: true }),
  detector('excessive_sticker', 'Excessive Sticker Detection', 'messages', { threshold: 3, deleteMessage: true }),
  detector('excessive_gif', 'Excessive GIF Detection', 'messages', { threshold: 4, windowSeconds: 20, deleteMessage: true }),
  detector('mention_spam', 'Mention Spam', 'messages', { threshold: 4, deleteMessage: true }),
  detector('everyone_abuse', '@everyone Abuse', 'messages', { deleteMessage: true }),
  detector('here_abuse', '@here Abuse', 'messages', { deleteMessage: true }),
  detector('invisible_character', 'Invisible Character Detection', 'messages', { threshold: 3, deleteMessage: true }),
  detector('unicode_abuse', 'Unicode Abuse Detection', 'messages', { threshold: 10, deleteMessage: true, capability: 'heuristic' }),
  detector('zalgo_text', 'Zalgo Text Detection', 'messages', { threshold: 8, deleteMessage: true }),
  detector('obfuscated_text', 'Obfuscated Text Detection', 'messages', { deleteMessage: true, capability: 'heuristic' }),
  detector('empty_message_exploit', 'Empty Message Exploit Detection', 'messages', { deleteMessage: true }),
  detector('long_message', 'Long Message Detection', 'messages', { threshold: 1500, deleteMessage: true, severity: 'medium' }),
  detector('random_character_spam', 'Random Character Spam', 'messages', { threshold: 45, deleteMessage: true, capability: 'heuristic' }),
  detector('keyboard_smash', 'Keyboard Smash Detection', 'messages', { threshold: 16, deleteMessage: true, capability: 'heuristic' }),

  detector('discord_invite', 'Discord Invite Detection', 'links', { deleteMessage: true }),
  detector('external_invite', 'External Invite Detection', 'links', { deleteMessage: true, capability: 'heuristic' }),
  detector('scam_link', 'Scam Link Detection', 'links', { deleteMessage: true, capability: 'heuristic' }),
  detector('phishing_link', 'Phishing Link Detection', 'links', { deleteMessage: true, capability: 'heuristic', punishment: 'ban', severity: 'critical' }),
  detector('suspicious_url', 'Suspicious URL Detection', 'links', { deleteMessage: true, capability: 'heuristic' }),
  detector('url_shortener', 'URL Shortener Detection', 'links', { deleteMessage: true }),
  detector('malicious_domain', 'Malicious Domain Detection', 'links', { deleteMessage: true, capability: 'local-reputation', punishment: 'ban', severity: 'critical' }),
  detector('fake_discord_login', 'Fake Discord Login Detection', 'links', { deleteMessage: true, punishment: 'ban', severity: 'critical' }),
  detector('fake_nitro', 'Fake Nitro Detection', 'links', { deleteMessage: true, punishment: 'ban', severity: 'critical' }),
  detector('fake_steam_gift', 'Fake Steam Gift Detection', 'links', { deleteMessage: true, punishment: 'ban', severity: 'critical' }),
  detector('fake_roblox_login', 'Fake Roblox Login Detection', 'links', { deleteMessage: true, punishment: 'ban', severity: 'critical' }),
  detector('fake_verification', 'Fake Verification Detection', 'links', { deleteMessage: true, punishment: 'ban', severity: 'critical' }),
  detector('ip_logger', 'IP Logger Detection', 'links', { deleteMessage: true, punishment: 'ban', severity: 'critical' }),
  detector('qr_scam', 'QR Scam Detection', 'links', { deleteMessage: true, capability: 'heuristic', severity: 'critical' }),
  detector('webhook_url_leak', 'Webhook URL Leak Detection', 'links', { deleteMessage: true, severity: 'critical' }),

  detector('dangerous_attachment', 'Dangerous Attachment Detection', 'files', { deleteMessage: true, severity: 'critical' }),
  detector('executable_file', 'Executable File Detection', 'files', { deleteMessage: true, punishment: 'ban', severity: 'critical' }),
  detector('script_file', 'Script File Detection', 'files', { deleteMessage: true, severity: 'critical' }),
  detector('macro_file', 'Macro File Detection', 'files', { deleteMessage: true, severity: 'critical' }),
  detector('password_archive', 'Password Protected Archive Detection', 'files', { deleteMessage: true, capability: 'filename-heuristic' }),
  detector('oversized_file', 'Oversized File Detection', 'files', { threshold: 25, deleteMessage: true }),
  detector('suspicious_extension', 'Suspicious File Extension Detection', 'files', { deleteMessage: true, capability: 'heuristic' }),

  detector('suspicious_username', 'Suspicious Username Detection', 'profiles', { capability: 'heuristic', punishment: 'timeout' }),
  detector('scam_username', 'Scam Username Detection', 'profiles', { capability: 'heuristic', punishment: 'timeout' }),
  detector('mass_nickname_change', 'Mass Nickname Change Detection', 'profiles', { threshold: 5, windowSeconds: 30, punishment: 'remove_roles' }),
  detector('offensive_username', 'Offensive Username Detection', 'profiles', { capability: 'heuristic', punishment: 'timeout' }),
  detector('impersonation', 'Impersonation Detection', 'profiles', { capability: 'heuristic', punishment: 'timeout' }),
  detector('fake_staff', 'Fake Staff Detection', 'profiles', { capability: 'heuristic', punishment: 'timeout' }),
  detector('fake_bot', 'Fake Bot Detection', 'profiles', { capability: 'heuristic', punishment: 'timeout' }),
  detector('new_account', 'New Account Detection', 'profiles', { threshold: 1, punishment: 'timeout', severity: 'medium' }),
  detector('young_account', 'Young Account Detection', 'profiles', { threshold: 7, punishment: 'timeout', severity: 'medium' }),
  detector('default_avatar', 'Default Avatar Detection', 'profiles', { defaultEnabled: false, punishment: 'warn', severity: 'low' }),

  detector('mass_join', 'Mass Join Detection', 'raids', { threshold: 8, windowSeconds: 20, punishment: 'kick' }),
  detector('join_rate', 'Join Rate Detection', 'raids', { threshold: 12, windowSeconds: 60, punishment: 'kick' }),
  detector('invite_raid', 'Invite Raid Detection', 'raids', { threshold: 8, windowSeconds: 30, capability: 'invite-cache', punishment: 'kick' }),
  detector('bot_raid', 'Bot Raid Detection', 'raids', { threshold: 3, windowSeconds: 30, punishment: 'ban' }),
  detector('new_account_raid', 'New Account Raid Detection', 'raids', { threshold: 5, windowSeconds: 30, punishment: 'kick' }),
  detector('vpn_proxy', 'VPN / Proxy Detection', 'raids', { defaultEnabled: false, capability: 'unavailable-no-discord-ip', punishment: 'warn' }),
  detector('alt_account', 'Alt Account Detection', 'raids', { capability: 'heuristic', punishment: 'timeout' }),

  detector('channel_create_spam', 'Channel Create Spam', 'channels', { threshold: 4, windowSeconds: 30 }),
  detector('channel_delete_spam', 'Channel Delete Spam', 'channels', { threshold: 3, windowSeconds: 30 }),
  detector('channel_update_spam', 'Channel Update Spam', 'channels', { threshold: 5, windowSeconds: 30 }),
  detector('category_create_spam', 'Category Create Spam', 'channels', { threshold: 3, windowSeconds: 30 }),
  detector('category_delete_spam', 'Category Delete Spam', 'channels', { threshold: 2, windowSeconds: 30 }),
  detector('category_update_spam', 'Category Update Spam', 'channels', { threshold: 4, windowSeconds: 30 }),

  detector('role_create_spam', 'Role Create Spam', 'roles', { threshold: 4, windowSeconds: 30 }),
  detector('role_delete_spam', 'Role Delete Spam', 'roles', { threshold: 3, windowSeconds: 30 }),
  detector('role_update_spam', 'Role Update Spam', 'roles', { threshold: 5, windowSeconds: 30 }),
  detector('permission_escalation', 'Permission Escalation Detection', 'roles', { threshold: 1, severity: 'critical' }),
  detector('administrator_permission', 'Administrator Permission Detection', 'roles', { threshold: 1, severity: 'critical' }),
  detector('dangerous_permission', 'Dangerous Permission Detection', 'roles', { threshold: 1, severity: 'critical' }),

  detector('mass_kick', 'Mass Kick Detection', 'members', { threshold: 3, windowSeconds: 30 }),
  detector('mass_ban', 'Mass Ban Detection', 'members', { threshold: 3, windowSeconds: 30 }),
  detector('mass_timeout', 'Mass Timeout Detection', 'members', { threshold: 4, windowSeconds: 30 }),
  detector('mass_unban', 'Mass Unban Detection', 'members', { threshold: 3, windowSeconds: 30 }),
  detector('member_mass_nickname', 'Mass Nickname Change Detection', 'members', { threshold: 5, windowSeconds: 30 }),
  detector('mass_role_assignment', 'Mass Role Assignment Detection', 'members', { threshold: 4, windowSeconds: 30 }),

  detector('webhook_creation', 'Webhook Creation Detection', 'webhooks', { threshold: 1 }),
  detector('webhook_deletion', 'Webhook Deletion Detection', 'webhooks', { threshold: 1 }),
  detector('webhook_spam', 'Webhook Spam Detection', 'webhooks', { threshold: 3, windowSeconds: 30 }),
  detector('unauthorized_webhook', 'Unauthorized Webhook Detection', 'webhooks', { threshold: 1, severity: 'critical' }),

  detector('server_name_change', 'Server Name Change Detection', 'server'),
  detector('server_icon_change', 'Server Icon Change Detection', 'server'),
  detector('server_banner_change', 'Server Banner Change Detection', 'server'),
  detector('vanity_url_change', 'Vanity URL Change Detection', 'server'),
  detector('verification_level_change', 'Verification Level Change Detection', 'server'),
  detector('automod_change', 'AutoMod Change Detection', 'server'),
  detector('community_setting_change', 'Community Setting Change Detection', 'server'),
  detector('integration_change', 'Integration Change Detection', 'server'),

  detector('voice_channel_spam', 'Voice Channel Spam', 'voice', { threshold: 8, windowSeconds: 30 }),
  detector('voice_join_spam', 'Voice Channel Join Spam', 'voice', { threshold: 5, windowSeconds: 20, punishment: 'timeout' }),
  detector('voice_leave_spam', 'Voice Channel Leave Spam', 'voice', { threshold: 5, windowSeconds: 20, punishment: 'timeout' }),
  detector('voice_move_spam', 'Voice Channel Move Spam', 'voice', { threshold: 5, windowSeconds: 20 }),
  detector('soundboard_spam', 'Soundboard Spam', 'voice', { threshold: 6, windowSeconds: 15, punishment: 'timeout' }),
  detector('stage_abuse', 'Stage Abuse Detection', 'voice', { threshold: 4, windowSeconds: 30 }),

  detector('thread_create_spam', 'Thread Create Spam', 'threads', { threshold: 5, windowSeconds: 30 }),
  detector('thread_delete_spam', 'Thread Delete Spam', 'threads', { threshold: 3, windowSeconds: 30 }),
  detector('thread_update_spam', 'Thread Update Spam', 'threads', { threshold: 5, windowSeconds: 30 }),

  detector('emoji_create_spam', 'Emoji Create Spam', 'assets', { threshold: 5, windowSeconds: 30 }),
  detector('emoji_delete_spam', 'Emoji Delete Spam', 'assets', { threshold: 3, windowSeconds: 30 }),
  detector('emoji_update_spam', 'Emoji Update Spam', 'assets', { threshold: 5, windowSeconds: 30 }),
  detector('sticker_create_spam', 'Sticker Create Spam', 'assets', { threshold: 4, windowSeconds: 30 }),
  detector('sticker_delete_spam', 'Sticker Delete Spam', 'assets', { threshold: 3, windowSeconds: 30 }),
  detector('sticker_update_spam', 'Sticker Update Spam', 'assets', { threshold: 4, windowSeconds: 30 }),

  detector('mass_channel_delete', 'Mass Channel Delete', 'antinuke', { threshold: 3, windowSeconds: 20, severity: 'critical' }),
  detector('mass_channel_create', 'Mass Channel Create', 'antinuke', { threshold: 5, windowSeconds: 20, severity: 'critical' }),
  detector('mass_role_delete', 'Mass Role Delete', 'antinuke', { threshold: 3, windowSeconds: 20, severity: 'critical' }),
  detector('mass_role_create', 'Mass Role Create', 'antinuke', { threshold: 5, windowSeconds: 20, severity: 'critical' }),
  detector('mass_webhook_create', 'Mass Webhook Create', 'antinuke', { threshold: 3, windowSeconds: 20, severity: 'critical' }),
  detector('mass_webhook_delete', 'Mass Webhook Delete', 'antinuke', { threshold: 3, windowSeconds: 20, severity: 'critical' }),
  detector('mass_permission_changes', 'Mass Permission Changes', 'antinuke', { threshold: 3, windowSeconds: 20, severity: 'critical' }),
  detector('mass_server_updates', 'Mass Server Updates', 'antinuke', { threshold: 3, windowSeconds: 20, severity: 'critical' }),
  detector('mass_emoji_delete', 'Mass Emoji Delete', 'antinuke', { threshold: 4, windowSeconds: 20, severity: 'critical' }),
  detector('mass_sticker_delete', 'Mass Sticker Delete', 'antinuke', { threshold: 3, windowSeconds: 20, severity: 'critical' }),
  detector('mass_integration_changes', 'Mass Integration Changes', 'antinuke', { threshold: 2, windowSeconds: 20, severity: 'critical' }),
  detector('mass_bot_additions', 'Mass Bot Additions', 'antinuke', { threshold: 2, windowSeconds: 30, severity: 'critical' })
]);

const CATALOG_BY_ID = new Map(DETECTOR_CATALOG.map((item) => [item.id, item]));

export function defaultDetectorSettings() {
  return Object.fromEntries(DETECTOR_CATALOG.map((item) => [item.id, {
    enabled: item.defaultEnabled,
    threshold: item.defaultThreshold,
    windowSeconds: item.defaultWindowSeconds,
    punishment: item.defaultPunishment,
    deleteMessage: item.deleteMessage
  }]));
}

export function normalizeDetectorSettings(value = {}) {
  const defaults = defaultDetectorSettings();
  for (const [id, candidate] of Object.entries(value || {})) {
    const catalog = CATALOG_BY_ID.get(id);
    if (!catalog || !candidate || typeof candidate !== 'object') continue;
    const fallback = defaults[id];
    const punishment = ['warn', 'timeout', 'remove_roles', 'quarantine', 'kick', 'ban', 'none'].includes(String(candidate.punishment || ''))
      ? String(candidate.punishment)
      : fallback.punishment;
    defaults[id] = {
      enabled: candidate.enabled === undefined ? fallback.enabled : Boolean(candidate.enabled),
      threshold: Math.max(1, Math.min(10000, Number(candidate.threshold) || fallback.threshold)),
      windowSeconds: Math.max(1, Math.min(3600, Number(candidate.windowSeconds) || fallback.windowSeconds)),
      punishment,
      deleteMessage: candidate.deleteMessage === undefined ? fallback.deleteMessage : Boolean(candidate.deleteMessage)
    };
  }
  return defaults;
}

export function detectorConfig(settings, id) {
  return settings?.detectors?.[id] || defaultDetectorSettings()[id] || { enabled: false, threshold: 1, windowSeconds: 60, punishment: 'none', deleteMessage: false };
}

export function detectorDefinition(id) {
  return CATALOG_BY_ID.get(id) || null;
}

function normalizeContent(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function countRecent(records, seconds, predicate = () => true, now = Date.now()) {
  const cutoff = now - Number(seconds || 60) * 1000;
  return records.filter((record) => record.timestamp >= cutoff && predicate(record)).length;
}

function levenshtein(left, right) {
  const a = left.slice(0, 300);
  const b = right.slice(0, 300);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

function similarity(left, right) {
  const longest = Math.max(left.length, right.length);
  if (!longest) return 1;
  return 1 - (levenshtein(left, right) / longest);
}

function entropy(value) {
  if (!value) return 0;
  const counts = new Map();
  for (const char of value) counts.set(char, (counts.get(char) || 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function extractUrls(content) {
  const matches = String(content || '').match(/https?:\/\/[^\s<>]+/gi) || [];
  return matches.slice(0, 20).map((raw) => {
    try {
      const parsed = new URL(raw.replace(/[),.!?]+$/, ''));
      return { raw, url: parsed, host: parsed.hostname.toLowerCase().replace(/^www\./, '') };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

const SHORTENERS = new Set(['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'is.gd', 'cutt.ly', 'rb.gy', 'rebrand.ly', 'shorturl.at', 'tiny.one']);
const IP_LOGGERS = new Set(['grabify.link', 'iplogger.org', 'iplogger.com', '2no.co', 'yip.su', 'blasze.com', 'bmwforum.co', 'stopify.co', 'leancoding.co']);
const MALICIOUS_DOMAINS = new Set(['discord-gift.com', 'discordnitro.click', 'steamcomnunity.com', 'roblox-login.com', 'discord-verification.com', 'dlscord-app.com']);
const OFFICIAL = {
  discord: ['discord.com', 'discord.gg', 'discordapp.com'],
  steam: ['steampowered.com', 'steamcommunity.com'],
  roblox: ['roblox.com', 'rbxcdn.com']
};

function hostIsOfficial(host, group) {
  return OFFICIAL[group].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function attachmentArray(message) {
  if (!message?.attachments) return [];
  if (typeof message.attachments.values === 'function') return [...message.attachments.values()];
  return Array.isArray(message.attachments) ? message.attachments : [];
}

function enabled(settings, id) {
  return detectorConfig(settings, id).enabled;
}

function makeHit(id, reason, evidence = '') {
  const definition = detectorDefinition(id);
  return {
    detectorId: id,
    detectorName: definition?.label || id,
    reason,
    evidence: String(evidence || '').slice(0, 500),
    severity: definition?.severity || 'high',
    category: definition?.category || 'unknown'
  };
}

export function makeMessageRecord(message, timestamp = Date.now()) {
  const content = String(message?.content || '');
  const attachments = attachmentArray(message);
  const gifCount = attachments.filter((item) => String(item.contentType || '').includes('gif') || /\.gif(?:$|\?)/i.test(item.url || item.name || '')).length
    + (message?.embeds || []).filter((item) => item?.type === 'gifv' || /(?:giphy|tenor)\.com/i.test(item?.url || '')).length
    + (/https?:\/\/(?:[^\s]+\.)?(?:giphy|tenor)\.com/i.test(content) ? 1 : 0);
  return {
    timestamp,
    channelId: message?.channelId || message?.channel?.id || null,
    content,
    normalized: normalizeContent(content),
    attachmentCount: attachments.length,
    stickerCount: Number(message?.stickers?.size || 0),
    gifCount
  };
}

export function evaluateMessageDetectors({ message, records = [], settings, now = Date.now() }) {
  const hits = [];
  const content = String(message?.content || '');
  const normalized = normalizeContent(content);
  const current = records[records.length - 1] || makeMessageRecord(message, now);
  const add = (id, condition, reason, evidence = '') => {
    if (condition && enabled(settings, id)) hits.push(makeHit(id, reason, evidence));
  };

  for (const id of ['spam', 'flood', 'fast_message_spam']) {
    const cfg = detectorConfig(settings, id);
    const count = countRecent(records, cfg.windowSeconds, () => true, now);
    add(id, count >= cfg.threshold, `${count} mensagens em ${cfg.windowSeconds}s`, `count=${count}`);
  }

  if (normalized) {
    const duplicateCfg = detectorConfig(settings, 'duplicate_message');
    const duplicates = countRecent(records, duplicateCfg.windowSeconds, (record) => record.normalized === normalized, now);
    add('duplicate_message', duplicates >= duplicateCfg.threshold, `${duplicates} mensagens identicas`, normalized);

    const similarCfg = detectorConfig(settings, 'similar_message');
    const similarMessages = records.filter((record) => record !== current && record.normalized && record.timestamp >= now - similarCfg.windowSeconds * 1000 && record.normalized !== normalized && similarity(record.normalized, normalized) >= 0.88).length + 1;
    add('similar_message', similarMessages >= similarCfg.threshold, `${similarMessages} mensagens muito semelhantes`, normalized);

    const copyCfg = detectorConfig(settings, 'copy_paste_spam');
    const copied = records.filter((record) => record.timestamp >= now - copyCfg.windowSeconds * 1000 && record.normalized === normalized);
    add('copy_paste_spam', copied.length >= copyCfg.threshold && new Set(copied.map((item) => item.channelId)).size > 1, `${copied.length} copias em canais diferentes`, normalized);
  }

  const charCfg = detectorConfig(settings, 'excessive_character');
  const longestRun = Math.max(0, ...((content.match(/(.)\1{5,}/gu) || []).map((item) => item.length)));
  add('excessive_character', longestRun >= charCfg.threshold, `sequencia de ${longestRun} caracteres repetidos`, content);

  const words = normalized.match(/[\p{L}\p{N}_]+/gu) || [];
  const wordCounts = new Map();
  for (const word of words) wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
  const repeatedWordCount = Math.max(0, ...wordCounts.values());
  const repeatedWord = [...wordCounts].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
  add('repeated_word', repeatedWordCount >= detectorConfig(settings, 'repeated_word').threshold, `palavra repetida ${repeatedWordCount} vezes`, repeatedWord);

  const letters = content.match(/\p{L}/gu) || [];
  const upper = content.match(/\p{Lu}/gu) || [];
  const capsPercent = letters.length ? Math.round((upper.length / letters.length) * 100) : 0;
  add('excessive_caps', letters.length >= 12 && capsPercent >= detectorConfig(settings, 'excessive_caps').threshold, `${capsPercent}% de letras maiusculas`, content);

  const emojiCount = (content.match(/\p{Extended_Pictographic}|<a?:\w+:\d+>/gu) || []).length;
  add('excessive_emoji', emojiCount >= detectorConfig(settings, 'excessive_emoji').threshold, `${emojiCount} emojis`, content);
  add('excessive_sticker', current.stickerCount >= detectorConfig(settings, 'excessive_sticker').threshold, `${current.stickerCount} stickers`, 'stickers');
  const gifCfg = detectorConfig(settings, 'excessive_gif');
  const gifCount = records.filter((record) => record.timestamp >= now - gifCfg.windowSeconds * 1000).reduce((sum, record) => sum + record.gifCount, 0);
  add('excessive_gif', gifCount >= gifCfg.threshold, `${gifCount} GIFs em ${gifCfg.windowSeconds}s`, 'gif');

  const rawMentionCount = (content.match(/<@!?\d+>|<@&\d+>/g) || []).length;
  const mentionCollectionCount = Number(message?.mentions?.users?.size || 0) + Number(message?.mentions?.roles?.size || 0);
  const mentionCount = Math.max(rawMentionCount, mentionCollectionCount);
  add('mention_spam', mentionCount >= detectorConfig(settings, 'mention_spam').threshold, `${mentionCount} mencoes`, content);
  add('everyone_abuse', /@everyone/i.test(content), 'uso de @everyone', content);
  add('here_abuse', /@here/i.test(content), 'uso de @here', content);

  const invisibleCount = (content.match(/[\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g) || []).length;
  add('invisible_character', invisibleCount >= detectorConfig(settings, 'invisible_character').threshold, `${invisibleCount} caracteres invisiveis`, content);
  const suspiciousUnicode = (content.match(/[\u202A-\u202E\u2066-\u2069\uFE00-\uFE0F]/g) || []).length;
  add('unicode_abuse', suspiciousUnicode >= detectorConfig(settings, 'unicode_abuse').threshold, `${suspiciousUnicode} controles Unicode suspeitos`, content);
  const combiningMarks = (content.normalize('NFD').match(/\p{M}/gu) || []).length;
  add('zalgo_text', combiningMarks >= detectorConfig(settings, 'zalgo_text').threshold, `${combiningMarks} marcas combinadas (zalgo)`, content);

  const deobfuscated = normalized.replace(/[._\-\s|/\\]+/g, '').replace(/[013457@$]/g, (char) => ({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' }[char] || char));
  add('obfuscated_text', /(?:discordnitro|freerobux|steamgift|verifyaccount|claimreward|supportstaff)/i.test(deobfuscated) && /[._\-\s|/\\013457@$]/.test(normalized), 'texto suspeito ofuscado', normalized);
  add('empty_message_exploit', !normalizeContent(content) && invisibleCount > 0 && !current.attachmentCount && !current.stickerCount, 'mensagem visualmente vazia com caracteres ocultos', content);
  add('long_message', content.length >= detectorConfig(settings, 'long_message').threshold, `mensagem com ${content.length} caracteres`, content);
  const compact = normalized.replace(/\s/g, '');
  add('random_character_spam', compact.length >= detectorConfig(settings, 'random_character_spam').threshold && entropy(compact) >= 4.4 && words.length <= 3, `texto aleatorio de alta entropia (${entropy(compact).toFixed(2)})`, compact);
  add('keyboard_smash', compact.length >= detectorConfig(settings, 'keyboard_smash').threshold && /(?:asdf|qwer|zxcv|jkl;|hjkl|1234){2,}/i.test(compact), 'padrao de keyboard smash', compact);

  const urls = extractUrls(content);
  const discordInvite = /(?:discord\.gg|discord(?:app)?\.com\/invite)\/[a-z0-9-]+/i.test(content);
  add('discord_invite', discordInvite, 'convite do Discord detectado', content);
  for (const item of urls) {
    const host = item.host;
    const path = `${item.url.pathname}${item.url.search}`.toLowerCase();
    const full = item.url.toString();
    add('url_shortener', SHORTENERS.has(host), `encurtador de URL: ${host}`, full);
    add('ip_logger', IP_LOGGERS.has(host), `dominio de IP logger: ${host}`, full);
    add('malicious_domain', MALICIOUS_DOMAINS.has(host), `dominio malicioso conhecido: ${host}`, full);
    add('external_invite', !discordInvite && /(?:invite|join|referral|ref=|grupo|group)/i.test(path), `convite externo: ${host}`, full);
    add('fake_discord_login', !hostIsOfficial(host, 'discord') && /discord/i.test(host + path) && /(?:login|verify|oauth|gift|nitro)/i.test(path), `login Discord falso: ${host}`, full);
    add('fake_nitro', !hostIsOfficial(host, 'discord') && /(?:nitro|gift|discord)/i.test(host + path) && /(?:claim|free|redeem|gift)/i.test(content), `Nitro falso: ${host}`, full);
    add('fake_steam_gift', !hostIsOfficial(host, 'steam') && /steam/i.test(host + path) && /(?:gift|trade|login|claim)/i.test(content + path), `presente Steam falso: ${host}`, full);
    add('fake_roblox_login', !hostIsOfficial(host, 'roblox') && /(?:roblox|robux|rbx)/i.test(host + path) && /(?:login|free|verify|claim)/i.test(content + path), `login Roblox falso: ${host}`, full);
    add('fake_verification', /(?:verify|verification|captcha|authorize)/i.test(path) && !hostIsOfficial(host, 'discord'), `verificacao externa suspeita: ${host}`, full);
    add('phishing_link', /(?:login|signin|verify|password|token|wallet|authorize)/i.test(path) && (host.startsWith('xn--') || /discord|steam|roblox|paypal|microsoft|google/i.test(host)) && ![...OFFICIAL.discord, ...OFFICIAL.steam, ...OFFICIAL.roblox].some((domain) => host === domain || host.endsWith(`.${domain}`)), `possivel phishing: ${host}`, full);
    add('scam_link', /(?:free|claim|reward|airdrop|giveaway|limited|urgent|support)/i.test(content) && /(?:login|verify|gift|nitro|robux|steam|wallet)/i.test(content + path), `padrao de golpe: ${host}`, full);
    add('suspicious_url', host.startsWith('xn--') || /\d{1,3}(?:\.\d{1,3}){3}/.test(host) || /\.(?:zip|mov|click|top|xyz|cam|quest)$/i.test(host), `URL suspeita: ${host}`, full);
    add('webhook_url_leak', /(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[\w-]+/i.test(full), 'URL secreta de webhook exposta', full);
  }

  const attachments = attachmentArray(message);
  for (const attachment of attachments) {
    const name = String(attachment.name || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';
    const sizeMb = Number(attachment.size || 0) / 1024 / 1024;
    const executable = ['exe', 'msi', 'com', 'scr', 'bat', 'cmd', 'ps1', 'apk', 'dmg', 'pkg', 'jar'].includes(ext);
    const script = ['js', 'jse', 'vbs', 'vbe', 'wsf', 'wsh', 'hta', 'py', 'sh', 'lua'].includes(ext);
    const macro = ['docm', 'xlsm', 'pptm', 'xlam'].includes(ext);
    const suspicious = /\.(?:png|jpg|jpeg|gif|pdf|txt)\.(?:exe|scr|bat|cmd|js|vbs)$/i.test(name) || ['lnk', 'iso', 'img', 'reg', 'dll'].includes(ext);
    add('executable_file', executable, `arquivo executavel: ${name}`, name);
    add('script_file', script, `arquivo de script: ${name}`, name);
    add('macro_file', macro, `arquivo com macro: ${name}`, name);
    add('password_archive', /\.(?:zip|rar|7z)$/i.test(name) && /(?:pass|senha|password|locked|encrypted)/i.test(name + content), `arquivo compactado possivelmente protegido: ${name}`, name);
    add('oversized_file', sizeMb >= detectorConfig(settings, 'oversized_file').threshold, `arquivo com ${sizeMb.toFixed(1)} MB`, name);
    add('suspicious_extension', suspicious, `extensao suspeita ou dupla: ${name}`, name);
    add('dangerous_attachment', executable || script || macro || suspicious, `anexo perigoso: ${name}`, name);
    add('qr_scam', /(?:qr|qrcode|scan).*(?:verify|login|gift|nitro)/i.test(name + content), `possivel golpe por QR code: ${name}`, name);
  }

  return hits;
}

export function evaluateProfileDetectors({ member, settings, guildName = '', botName = '' }) {
  const hits = [];
  const user = member?.user || member;
  if (!user) return hits;
  const name = String(member?.displayName || member?.nickname || user.globalName || user.username || '');
  const normalized = normalizeContent(name).replace(/[^\p{L}\p{N}]/gu, '');
  const add = (id, condition, reason) => {
    if (condition && enabled(settings, id)) hits.push(makeHit(id, reason, name));
  };
  const ageDays = Math.max(0, (Date.now() - Number(user.createdTimestamp || 0)) / 86_400_000);
  add('suspicious_username', /(?:free|gift|nitro|claim|verify|support|ticket|reward)/i.test(normalized), `nome suspeito: ${name}`);
  add('scam_username', /(?:freenitro|freerobux|steamgift|claimreward|discordgift)/i.test(normalized), `nome associado a golpe: ${name}`);
  add('offensive_username', /(?:nazi|racist|terror|pedofil|estupro)/i.test(normalized), `nome potencialmente ofensivo: ${name}`);
  const protectedNames = [guildName, botName].map(normalizeContent).map((item) => item.replace(/[^\p{L}\p{N}]/gu, '')).filter((item) => item.length >= 4);
  add('impersonation', protectedNames.some((item) => item !== normalized && similarity(item, normalized) >= 0.88), `possivel imitacao de identidade: ${name}`);
  add('fake_staff', !user.bot && /(?:admin|administrator|moderator|modteam|staff|support|suporte|owner|dono)/i.test(normalized), `possivel falso staff: ${name}`);
  add('fake_bot', !user.bot && /(?:bot|automod|security|captcha|verification)/i.test(normalized), `conta humana se passando por bot: ${name}`);
  add('new_account', ageDays < detectorConfig(settings, 'new_account').threshold, `conta criada ha ${ageDays.toFixed(1)} dia(s)`);
  add('young_account', ageDays < detectorConfig(settings, 'young_account').threshold, `conta jovem: ${ageDays.toFixed(1)} dia(s)`);
  add('default_avatar', !user.avatar, 'conta sem avatar personalizado');
  add('alt_account', ageDays < 3 && !user.avatar && /\d{3,}$/.test(String(user.username || '')), 'padrao heuristico de conta alternativa');
  return hits;
}

export function detectorCatalogResponse() {
  return {
    categories: DETECTOR_CATEGORIES,
    detectors: DETECTOR_CATALOG,
    defaults: defaultDetectorSettings(),
    limitations: {
      vpn_proxy: 'O Discord nao fornece IP de membros a bots; requer um provedor externo com dados obtidos legitimamente.',
      password_archive: 'Sem baixar/descompactar o arquivo, a deteccao usa nome, extensao e contexto da mensagem.',
      malicious_domain: 'Usa reputacao local e heuristicas; uma API externa pode ampliar a cobertura.',
      qr_scam: 'Analise heuristica de nome/contexto; OCR/visao externa nao e executada pelo bot.'
    }
  };
}
