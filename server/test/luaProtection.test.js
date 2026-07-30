import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_LUA_SOURCE_BYTES,
  protectLuaSource,
  validateLuaSyntax,
  validateLuaUpload
} from '../src/luaProtection.js';

const validSource = (`local greeting = "Nexus"
local function main(name)
  if name then
    print(greeting .. " " .. name)
  end
end
main("teste")
`).repeat(8);

test('aceita sintaxe Lua estruturalmente válida', () => {
  assert.equal(validateLuaSyntax(validSource).valid, true);
});

test('aceita if aninhado logo após then', () => {
  const source = (`local function update(value)
  if value then
    if value.active then return value end
  end
  return nil
end
`).repeat(8);
  assert.equal(validateLuaSyntax(source).valid, true);
});

test('detecta string não fechada', () => {
  assert.equal(validateLuaSyntax('local x = "sem fim').valid, false);
});

test('detecta bloco sem end', () => {
  assert.equal(validateLuaSyntax('local function main() print("x")').valid, false);
});

test('detecta end inesperado', () => {
  assert.equal(validateLuaSyntax('local x = 1 end').valid, false);
});

for (const level of ['basic', 'normal', 'strong']) {
  test(`proteção ${level} preserva sintaxe e hashes`, () => {
    const result = protectLuaSource(validSource, { level, version: 'v-test' });
    assert.equal(result.syntaxValid, true);
    assert.equal(result.loadTestPassed, true);
    assert.equal(result.originalSha256.length, 64);
    assert.equal(result.protectedSha256.length, 64);
    assert.notEqual(result.originalSha256, result.protectedSha256);
    assert.ok(result.source.includes('loadstring'));
  });
}

test('publicações usam identificadores aleatórios', () => {
  const first = protectLuaSource(validSource, { level: 'normal', version: 'v-test' });
  const second = protectLuaSource(validSource, { level: 'normal', version: 'v-test' });
  assert.equal(first.originalSha256, second.originalSha256);
  assert.notEqual(first.protectedSha256, second.protectedSha256);
});

test('bloqueia publicação quando o original é inválido', () => {
  assert.throws(
    () => protectLuaSource(`${validSource}\nlocal function broken(`, { level: 'normal' }),
    (error) => error.code === 'LUA_SYNTAX_INVALID'
  );
});

test('aceita arquivo .lua dentro dos limites', () => {
  assert.equal(validateLuaUpload('nexus.lua', validSource).bytes, Buffer.byteLength(validSource));
});

test('bloqueia extensão diferente de .lua', () => {
  assert.throws(
    () => validateLuaUpload('nexus.txt', validSource),
    (error) => error.code === 'LUA_FILE_INVALID'
  );
});

test('bloqueia arquivo menor que 500 bytes', () => {
  assert.throws(
    () => validateLuaUpload('nexus.lua', 'print("x")'),
    (error) => error.code === 'LUA_FILE_TOO_SMALL'
  );
});

test('bloqueia arquivo maior que 8 MB', () => {
  assert.throws(
    () => validateLuaUpload('nexus.lua', 'a'.repeat(MAX_LUA_SOURCE_BYTES + 1)),
    (error) => error.code === 'LUA_FILE_TOO_LARGE'
  );
});
