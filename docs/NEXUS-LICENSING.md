# Nexus — licenças, Discord, HWID e loader

Esta atualização preserva as quatro áreas existentes: **Licenças**, **Tags por
HWID**, **Loader protegido** e **Acesso ao painel**. O gerador, pagamentos,
estoque e outras funções antigas do repositório não fazem parte desta alteração.

## Estrutura analisada

- Backend: Node.js, Express e validação Zod.
- Frontend: React 18 e Vite.
- Bot: Discord.js v14, executado no mesmo runtime do backend.
- Banco: Postgres quando `DATABASE_URL` existe; SQLite local caso contrário.
- Autenticação do painel: Discord OAuth2, sessão HTTP-only e
  `authorized_users`.
- Licenças e keys: `license_users`, `license_plans` e `license_events`.
- HWID/tag/Roblox: `license_users.hwid` e `roblox_name_tags`.
- Publicações Lua: `loader_releases`.
- Cifragem anterior: AES-256-GCM em `server/src/crypto.js`.
- Integridade anterior: SHA-256 do payload.
- Tickets anteriores: objetos em memória, sem consumo atômico persistente.
- Permissões administrativas: owners/admins já existentes no painel.

## Problemas corrigidos

- O ticket do loader desaparecia em reinícios e não tinha consumo atômico
  persistente.
- Uma versão nova podia desativar a anterior antes de concluir todas as
  verificações.
- O arquivo armazenado não possuía key id para rotação de chave.
- O bot não tinha uma interface exclusiva para a licença do próprio Discord.
- O resgate não possuía transação, rate limit independente e auditoria segura.
- O reset do HWID não invalidava de forma completa os tickets e a associação
  Roblox da tag.
- Mensagens do loader estavam espalhadas e expunham erros técnicos.
- A key local não tinha fluxo isolado de leitura, gravação, remoção e máscara.
- Requisições duplicadas podiam aumentar a pontuação de compartilhamento.
- Proteção/publicação não validava metadados, tamanho, sintaxe, hashes e
  cifragem como uma única operação.
- A comunicação do bot com a API não possuía assinatura e proteção contra
  repetição.
- A key completa reaparecia ao reabrir a licença no painel.

## Pastas afetadas

```text
server/
  src/
    aesGcm.js
    botApiAuth.js
    botApiClient.js
    db.js
    discordRuntime.js
    licenseBot.js
    licenseBotApi.js
    licensePolicy.js
    licensing.js
    loader.js
    loaderPolicy.js
    loaderTickets.js
    luaProtection.js
    securityLimits.js
  test/
    luaProtection.test.js
    security.test.js
src/
  AppNexus.jsx
  stylesNexus.css
.env.example
package.json
```

## Bot do Discord

O bot usa a API Nexus como autoridade. Ele não lê diretamente dados críticos
para tomar decisões e não duplica a regra de licenciamento.

Comandos:

- `/nexus painel`: publica ou atualiza a Central do Usuário; somente owner/admin
  do sistema **Acesso ao painel**, ou ID presente em `NEXUS_BOT_OWNER_IDS`.
- `/licenca`: mostra a própria licença de forma efêmera.
- `/resgatar key`: resgata a key de forma efêmera e transacional.
- `/loader`: mostra URL fixa, loadstring, versão e status de forma efêmera.
- `/hwid resetar`: abre a confirmação e respeita o limite individual.
- `/historico`: mostra as últimas 10 ocorrências do próprio usuário.

Botões implementados:

```text
nexus_license_view
nexus_key_redeem
nexus_loader_copy
nexus_hwid_reset
nexus_history_view
nexus_support
nexus_panel_refresh
```

`nexus_support` reutiliza a configuração/suporte já existente. Nenhum segundo
sistema de tickets foi criado. O painel é reaproveitado: executar
`/nexus painel` novamente edita a mensagem encontrada em vez de criar cópias.

O bot nunca envia IP, HWID ou key completa. Informações pessoais usam respostas
efêmeras. O canal publicado vira o canal configurado para as interações do
painel. É possível restringir previamente por variáveis de ambiente.

## Comunicação bot → API

Cada chamada interna inclui:

- identificador do bot;
- timestamp com validade de 60 segundos;
- nonce aleatório;
- ID único de operação;
- método, caminho e hash SHA-256 do corpo;
- assinatura HMAC-SHA-256.

O nonce é armazenado como hash em `bot_api_nonces`, impedindo repetição. A API
não aceita apenas um Discord ID sem a assinatura interna válida.

## Resgate e reset do HWID

O resgate normaliza a key, aplica rate limit, consulta somente pelo hash, valida
status/expiração/vínculo e atualiza dentro de uma transação. A key completa não
entra em logs.

O reset:

1. identifica a licença pelo Discord da interação;
2. valida status, expiração, cooldown e limite;
3. limpa o HWID;
4. limpa Roblox/HWID da tag;
5. incrementa o contador;
6. invalida os tickets ativos;
7. registra evento e auditoria.

Falhas não deixam uma atualização parcial.

## Loader protegido

O link permanece fixo:

```text
/loader/nexus.lua
```

O bootstrap centraliza os textos em `MESSAGES` e altera o estado apenas por:

```lua
NexusStatus:SetState(state, message)
```

Também isola:

```lua
loadSavedKey()
saveKey(key)
deleteSavedKey()
maskKey(key)
```

Todas as operações locais usam `pcall`. A key completa não vai para console,
erros ou interface.

### Publicação

A tela existente **Loader protegido** recebeu níveis Básico, Normal e Forte e
as opções manuais solicitadas. O backend é a autoridade e exige:

- nome terminado em `.lua`;
- 500 bytes a 8 MB;
- conteúdo não vazio;
- validação estrutural de sintaxe Lua/Luau;
- SHA-256 original e protegido;
- transformação com identificadores aleatórios por publicação;
- teste estrutural da saída;
- AES-256-GCM autenticado com nonce novo;
- descriptografia de verificação antes de gravar;
- ativação e desativação dentro da mesma transação.

Se qualquer etapa falhar, a versão antiga continua ativa. A validação é
conservadora e bloqueia delimitadores, strings ou blocos incompletos. Como o
runtime de produção não inclui um interpretador Luau do Roblox, o “teste de
carregamento” valida estruturalmente o wrapper; o teste final ocorre no ambiente
Luau autorizado.

### Cifragem e rotação

Novas publicações usam o formato:

```text
v2:keyId:nonce:authenticationTag:ciphertext
```

`APP_MASTER_KEY` nunca vai para banco, frontend, loader ou log.
`APP_PREVIOUS_MASTER_KEYS` permite ler versões antigas durante uma rotação.
Payloads legados `v1` continuam compatíveis.

### Tickets

`loader_tickets` guarda somente o hash do token e o vínculo com licença,
versão, HWID, Roblox, nonce e expiração. O token possui 256 bits aleatórios,
dura 45 segundos e só pode ser utilizado uma vez.

O consumo faz um update condicional dentro da transação. Tentativas inválidas
também ficam persistidas; a sexta tentativa é bloqueada com a configuração
padrão de cinco. Nova versão, suspensão, reset do HWID e troca da key invalidam
os tickets ainda abertos.

Antes de responder, o servidor descriptografa somente em memória e compara o
SHA-256 protegido. Divergência gera alerta e bloqueia a entrega.

## Detecção de compartilhamento

Somente as duas regras existentes permanecem:

- três HWIDs diferentes em 30 minutos;
- seis redes aproximadas em uma hora.

HWIDs são normalizados. Eventos com o mesmo nonce, retries e valores repetidos
são deduplicados antes da contagem. A decisão registra os IDs dos eventos
utilizados sem registrar a key ou o ticket.

## Variáveis obrigatórias em produção

Copie `.env.example` e defina valores reais:

```env
DISCORD_BOT_TOKEN=
DISCORD_DEFAULT_GUILD_ID=
NEXUS_BOT_API_ID=nexus-discord-bot
NEXUS_BOT_API_SECRET=
NEXUS_BOT_API_URL=https://nexus-zks.squareweb.app
NEXUS_BOT_ALLOWED_GUILD_IDS=
NEXUS_BOT_ALLOWED_CHANNEL_IDS=
NEXUS_BOT_OWNER_IDS=

APP_MASTER_KEY=
APP_MASTER_KEY_ID=primary
APP_PREVIOUS_MASTER_KEYS=
SESSION_SECRET=
LOADER_TICKET_SECRET=
DATABASE_URL=
TRUST_PROXY=true
REQUIRE_HTTPS=true
```

Gere segredos diferentes:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Não reutilize o token do Discord como HMAC, chave AES ou segredo de ticket.

## Instalação e atualização

```bash
npm install
npm test
npm run build
npm run server:start
```

Na Square Cloud, mantenha:

```text
MAIN=server/src/index.js
START=npm run build && npm run server:start
AUTORESTART=true
```

Passos de atualização:

1. salve as variáveis no ambiente da aplicação;
2. mantenha o Postgres persistente configurado;
3. envie o commit;
4. reinicie/redeploy a aplicação;
5. confirme no log “Discord bot conectado ao Gateway”;
6. confirme a lista dos comandos sincronizados;
7. execute `/nexus painel` no canal permitido;
8. publique um Lua de teste inativo;
9. valide hashes e então ative a versão.

As migrações criam as novas colunas e tabelas automaticamente sem apagar as
licenças, tags ou versões atuais.

## Permissões do Discord

Para a Central do Usuário:

- View Channel;
- Send Messages;
- Embed Links;
- Use Application Commands;
- Read Message History.

Não é necessário Administrator, Manage Server, Ban Members, Kick Members ou
Manage Roles para esta central. Recursos antigos de anti-nuke/moderação do
mesmo bot podem exigir permissões próprias, mas não fazem parte da Central de
Licenças.

## Testes

Execute:

```bash
npm test
```

A suíte cobre 44 verificações unitárias e de persistência SQLite, incluindo:

- normalização e estados de resgate;
- key inválida, expirada, suspensa e vinculada;
- deduplicação por nonce/HWID/rede;
- três HWIDs e seis redes;
- ticket válido, expirado, usado, invalidado, de outro HWID/Roblox/versão;
- suspensão, expiração e limite de tentativas;
- sintaxe Lua, strings/blocos incompletos e três níveis;
- arquivo menor que 500 bytes, maior que 8 MB e extensão inválida;
- hashes e aleatoriedade por publicação;
- AES-256-GCM válido, adulterado e com chave incorreta.
- consumo atômico único, nonce duplicado, rollback de publicação e proteção
  contra exclusão da versão ativa.
- clique duplicado e liberação após o cooldown do Discord.

Antes de produção, faça também um smoke test com Postgres, Discord de testes e
um arquivo Luau representativo do script real.

## Checklist de segurança

- [ ] Segredos existem somente no ambiente da Square Cloud.
- [ ] `DATABASE_URL` aponta para armazenamento persistente.
- [ ] `TRUST_PROXY=true` e `REQUIRE_HTTPS=true`.
- [ ] OAuth2 possui somente o redirect de produção correto.
- [ ] Bot não possui Administrator.
- [ ] Canal e servidor do painel estão restringidos.
- [ ] Key/HWID/IP/ticket não aparecem nos logs.
- [ ] Chave AES possui 32 bytes e key id definido.
- [ ] Segredo HMAC do bot é diferente do segredo do ticket.
- [ ] Publicação inválida não troca a versão ativa.
- [ ] A versão anterior foi mantida para rollback.
- [ ] Testes passaram antes do deploy.
