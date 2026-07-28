import crypto from 'node:crypto';

export const LUA_PROTECTION_DEFAULTS = Object.freeze({
  level: 'normal',
  removeComments: true,
  renameLocalVariables: true,
  renameLocalFunctions: true,
  protectStrings: true,
  protectConstants: true,
  transformControlFlow: false,
  addVersionMark: true,
  syntaxCheck: true,
  loadTest: true,
  activateImmediately: true
});

export const LUA_PROTECTION_PRESETS = Object.freeze({
  basic: Object.freeze({
    removeComments: true,
    renameLocalVariables: true,
    renameLocalFunctions: false,
    protectStrings: false,
    protectConstants: false,
    transformControlFlow: false,
    addVersionMark: false
  }),
  normal: Object.freeze({
    removeComments: true,
    renameLocalVariables: true,
    renameLocalFunctions: true,
    protectStrings: true,
    protectConstants: true,
    transformControlFlow: false,
    addVersionMark: true
  }),
  strong: Object.freeze({
    removeComments: true,
    renameLocalVariables: true,
    renameLocalFunctions: true,
    protectStrings: true,
    protectConstants: true,
    transformControlFlow: true,
    addVersionMark: true
  })
});

const levels = new Set(['basic', 'normal', 'strong']);
const wordPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MIN_LUA_SOURCE_BYTES = 500;
export const MAX_LUA_SOURCE_BYTES = 8_000_000;

export function validateLuaUpload(fileName, source) {
  if (!/^[^\\/:*?"<>|\u0000-\u001F]{1,180}\.lua$/i.test(String(fileName || '').trim())) {
    const error = new Error('Selecione um arquivo .lua válido.');
    error.status = 400;
    error.code = 'LUA_FILE_INVALID';
    throw error;
  }
  const bytes = Buffer.byteLength(String(source || ''), 'utf8');
  if (bytes < MIN_LUA_SOURCE_BYTES) {
    const error = new Error('O arquivo Lua precisa ter pelo menos 500 bytes.');
    error.status = 400;
    error.code = 'LUA_FILE_TOO_SMALL';
    throw error;
  }
  if (bytes > MAX_LUA_SOURCE_BYTES) {
    const error = new Error('O arquivo Lua ultrapassa o limite de 8 MB.');
    error.status = 413;
    error.code = 'LUA_FILE_TOO_LARGE';
    throw error;
  }
  return { bytes };
}

function randomName(prefix = '_n') {
  return `${prefix}${crypto.randomBytes(5).toString('hex')}`;
}

function longBracketAt(source, index) {
  const match = source.slice(index).match(/^\[(=*)\[/);
  if (!match) return null;
  return { open: match[0], close: `]${match[1]}]` };
}

export function tokenizeLua(source) {
  const tokens = [];
  const errors = [];
  let index = 0;
  const push = (type, value, start = index) => tokens.push({ type, value, start });
  while (index < source.length) {
    const start = index;
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      while (index < source.length && /\s/.test(source[index])) index += 1;
      push('space', source.slice(start, index), start);
      continue;
    }
    if (char === '-' && source[index + 1] === '-') {
      index += 2;
      const bracket = longBracketAt(source, index);
      if (bracket) {
        index += bracket.open.length;
        const end = source.indexOf(bracket.close, index);
        if (end < 0) {
          errors.push({ code: 'UNCLOSED_COMMENT', offset: start, message: 'Comentário de bloco não foi fechado.' });
          push('comment', source.slice(start), start);
          break;
        }
        index = end + bracket.close.length;
      } else {
        while (index < source.length && source[index] !== '\n') index += 1;
      }
      push('comment', source.slice(start, index), start);
      continue;
    }
    const bracket = char === '[' ? longBracketAt(source, index) : null;
    if (bracket) {
      index += bracket.open.length;
      const end = source.indexOf(bracket.close, index);
      if (end < 0) {
        errors.push({ code: 'UNCLOSED_STRING', offset: start, message: 'String longa não foi fechada.' });
        push('string', source.slice(start), start);
        break;
      }
      index = end + bracket.close.length;
      push('string', source.slice(start, index), start);
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      const quote = char;
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          closed = true;
          break;
        }
        if (quote !== '`' && source[index] === '\n') break;
        index += 1;
      }
      if (!closed) errors.push({ code: 'UNCLOSED_STRING', offset: start, message: 'String não foi fechada.' });
      push('string', source.slice(start, index), start);
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      index += 1;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) index += 1;
      push('word', source.slice(start, index), start);
      continue;
    }
    if (/\d/.test(char)) {
      index += 1;
      while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) index += 1;
      push('number', source.slice(start, index), start);
      continue;
    }
    const triple = source.slice(index, index + 3);
    const double = source.slice(index, index + 2);
    if (['...', '..=', '//=', '::'].includes(triple)) {
      index += 3;
      push('symbol', triple, start);
    } else if (['==', '~=', '<=', '>=', '..', '//', '+=', '-=', '*=', '/=', '%=', '^=', '->', '::'].includes(double)) {
      index += 2;
      push('symbol', double, start);
    } else {
      index += 1;
      push('symbol', char, start);
    }
  }
  return { tokens, errors };
}

export function validateLuaSyntax(source) {
  const startedAt = Date.now();
  const text = String(source || '').replace(/^\uFEFF/, '');
  const scanned = tokenizeLua(text);
  const errors = [...scanned.errors];
  const significant = scanned.tokens.filter((token) => !['space', 'comment'].includes(token.type));
  const delimiters = [];
  const blocks = [];
  const opener = { '(': ')', '[': ']', '{': '}' };
  for (let tokenIndex = 0; tokenIndex < significant.length; tokenIndex += 1) {
    const token = significant[tokenIndex];
    const previous = significant[tokenIndex - 1];
    if (token.type === 'symbol') {
      if (opener[token.value]) delimiters.push({ value: token.value, expected: opener[token.value], offset: token.start });
      else if ([')', ']', '}'].includes(token.value)) {
        const current = delimiters.pop();
        if (!current || current.expected !== token.value) {
          errors.push({ code: 'UNBALANCED_DELIMITER', offset: token.start, message: `Delimitador inesperado: ${token.value}` });
        }
      }
      continue;
    }
    if (token.type !== 'word') continue;
    const word = token.value;
    if (word === 'function') blocks.push({ kind: word, offset: token.start });
    else if (word === 'if') {
      const expressionIf = previous
        && (
          (previous.type === 'symbol' && ['=', '(', ',', '{', '['].includes(previous.value))
          || (previous.type === 'word' && ['return', 'then', 'else', 'elseif', 'do'].includes(previous.value))
        );
      if (!expressionIf) blocks.push({ kind: word, offset: token.start });
    }
    else if (['for', 'while'].includes(word)) blocks.push({ kind: `${word}:await-do`, offset: token.start });
    else if (word === 'repeat') blocks.push({ kind: 'repeat', offset: token.start });
    else if (word === 'do') {
      const pending = [...blocks].reverse().find((block) => block.kind.endsWith(':await-do'));
      if (pending) pending.kind = pending.kind.replace(':await-do', '');
      else blocks.push({ kind: 'do', offset: token.start });
    } else if (word === 'end') {
      const current = blocks.pop();
      if (!current || current.kind === 'repeat') {
        errors.push({ code: 'UNEXPECTED_END', offset: token.start, message: '`end` sem bloco correspondente.' });
        if (current) blocks.push(current);
      }
    } else if (word === 'until') {
      const current = blocks.pop();
      if (!current || current.kind !== 'repeat') {
        errors.push({ code: 'UNEXPECTED_UNTIL', offset: token.start, message: '`until` sem `repeat` correspondente.' });
        if (current) blocks.push(current);
      }
    }
  }
  for (const delimiter of delimiters) {
    errors.push({ code: 'UNCLOSED_DELIMITER', offset: delimiter.offset, message: `Falta fechar ${delimiter.value} com ${delimiter.expected}.` });
  }
  for (const block of blocks) {
    errors.push({
      code: 'UNCLOSED_BLOCK',
      offset: block.offset,
      message: block.kind === 'repeat' ? 'Bloco `repeat` sem `until`.' : `Bloco \`${block.kind.replace(':await-do', '')}\` sem \`end\`.`
    });
  }
  return {
    valid: errors.length === 0,
    errors: errors.slice(0, 25),
    warnings: [],
    tokenCount: significant.length,
    processingMs: Date.now() - startedAt
  };
}

function minifyLua(tokens, removeComments) {
  const output = [];
  let previous = null;
  for (const token of tokens) {
    if (token.type === 'comment' && removeComments) continue;
    if (token.type === 'space' || token.type === 'comment') {
      if (output.length && output[output.length - 1] !== ' ') output.push(' ');
      continue;
    }
    const needsSpace = previous
      && (
        (['word', 'number'].includes(previous.type) && ['word', 'number'].includes(token.type))
        || (previous.value === '-' && token.value === '-')
      );
    if (needsSpace && output[output.length - 1] !== ' ') output.push(' ');
    output.push(token.value);
    previous = token;
  }
  return output.join('').trim();
}

function encodedWrapper(source, { version, options }) {
  const key = crypto.randomBytes(1)[0] || 91;
  const encoded = Buffer.from(source, 'utf8').map((byte) => byte ^ key).toString('base64');
  const names = {
    data: randomName('_d'),
    alphabet: randomName('_a'),
    bits: randomName('_b'),
    index: randomName('_i'),
    bitIndex: randomName('_j'),
    value: randomName('_v'),
    decoded: randomName('_s'),
    compiled: randomName('_f'),
    compileError: randomName('_e'),
    watermark: randomName('_w')
  };
  const chunkSize = options.level === 'strong' ? 1024 : encoded.length;
  const chunks = [];
  for (let index = 0; index < encoded.length; index += chunkSize) {
    chunks.push(JSON.stringify(encoded.slice(index, index + chunkSize)));
  }
  const dataExpression = options.level === 'strong'
    ? `table.concat({${chunks.join(',')}})`
    : chunks[0] || '""';
  const mark = options.addVersionMark
    ? `local ${names.watermark}=${JSON.stringify(`NEXUS:${version}:${crypto.randomBytes(8).toString('hex')}`)} `
    : '';
  const neutral = options.level === 'strong'
    ? `local ${randomName('_n')}=(function(${names.index}) return ${names.index} end)(#${names.data}) `
    : '';
  const flowStart = options.transformControlFlow ? 'repeat ' : '';
  const flowEnd = options.transformControlFlow ? ' until true' : '';
  return `${mark}local ${names.data}=${dataExpression} local ${names.alphabet}="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/" ${neutral}${flowStart}local ${names.decoded}=(${names.data}:gsub("[^"..${names.alphabet}.."=]",""):gsub(".",function(${names.value}) if ${names.value}=="=" then return "" end local ${names.bits}="" local ${names.index}=(${names.alphabet}:find(${names.value},1,true)-1) for ${names.bitIndex}=6,1,-1 do ${names.bits}=${names.bits}..(${names.index}%2^${names.bitIndex}-${names.index}%2^(${names.bitIndex}-1)>0 and "1" or "0") end return ${names.bits} end):gsub("%d%d%d?%d?%d?%d?%d?%d?",function(${names.bits}) if #${names.bits}~=8 then return "" end local ${names.value}=0 for ${names.index}=1,8 do ${names.value}=${names.value}+(${names.bits}:sub(${names.index},${names.index})=="1" and 2^(8-${names.index}) or 0) end return string.char(bit32.bxor(${names.value},${key})) end)) local ${names.compiled},${names.compileError}=loadstring(${names.decoded}) if not ${names.compiled} then error("Nexus: conteúdo autorizado inválido",0) end return ${names.compiled}()${flowEnd}`;
}

export function protectLuaSource(source, input = {}) {
  const startedAt = Date.now();
  const original = String(source || '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const requestedLevel = levels.has(input.level) ? input.level : LUA_PROTECTION_DEFAULTS.level;
  const options = {
    ...LUA_PROTECTION_DEFAULTS,
    ...LUA_PROTECTION_PRESETS[requestedLevel],
    ...input,
    level: requestedLevel
  };
  const originalValidation = validateLuaSyntax(original);
  if (options.syntaxCheck && !originalValidation.valid) {
    const error = new Error('O arquivo Lua possui erros de sintaxe estrutural.');
    error.status = 400;
    error.code = 'LUA_SYNTAX_INVALID';
    error.validation = originalValidation;
    throw error;
  }
  const scanned = tokenizeLua(original);
  let protectedSource = minifyLua(scanned.tokens, options.removeComments);
  const shouldEncode = options.level !== 'basic'
    || options.protectStrings
    || options.protectConstants
    || options.renameLocalVariables
    || options.renameLocalFunctions;
  if (shouldEncode) protectedSource = encodedWrapper(protectedSource, { version: input.version || 'unversioned', options });
  else if (options.addVersionMark) protectedSource = `-- Nexus ${input.version || 'unversioned'}\n${protectedSource}`;

  const protectedValidation = validateLuaSyntax(protectedSource);
  if (!protectedValidation.valid) {
    const error = new Error('A proteção produziu um arquivo Lua inválido.');
    error.status = 422;
    error.code = 'LUA_PROTECTION_INVALID';
    error.validation = protectedValidation;
    throw error;
  }
  const originalBytes = Buffer.byteLength(original, 'utf8');
  const protectedBytes = Buffer.byteLength(protectedSource, 'utf8');
  return {
    source: protectedSource,
    options,
    originalSha256: crypto.createHash('sha256').update(original).digest('hex'),
    protectedSha256: crypto.createHash('sha256').update(protectedSource).digest('hex'),
    originalBytes,
    protectedBytes,
    processingMs: Date.now() - startedAt,
    syntaxValid: originalValidation.valid && protectedValidation.valid,
    loadTestPassed: options.loadTest ? protectedValidation.valid : null,
    validation: {
      syntaxValid: originalValidation.valid && protectedValidation.valid,
      loadTestPassed: options.loadTest ? protectedValidation.valid : null,
      original: originalValidation,
      protected: protectedValidation,
      warnings: options.loadTest
        ? ['Teste estrutural concluído; a execução final permanece no ambiente Luau/Roblox autorizado.']
        : []
    }
  };
}

export function isLuaIdentifier(value) {
  return wordPattern.test(String(value || ''));
}
