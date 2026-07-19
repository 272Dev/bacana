# Nexus

Nexus e um cofre privado de contas para PC e mobile, com login exclusivo via Discord OAuth2, whitelist por Discord ID, senhas criptografadas e integracao com perfis publicos do Roblox.

## Stack

- Frontend: React + Vite, responsivo e instalavel como PWA.
- Desktop: Electron apontando para a interface web local.
- Backend: Node.js + Express.
- Banco: SQLite local ou Postgres/Neon em producao.
- Seguranca: AES-256-GCM para dados sensiveis, cookie HTTP-only, rate limit, bloqueio temporario e logs de auditoria.

## Configuracao

1. Instale as dependencias.

```bash
npm install
```

2. Crie o arquivo `.env` a partir de `.env.example`.

```bash
cp .env.example .env
```

No Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

3. Gere as chaves.

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
```

Use a primeira em `APP_MASTER_KEY` e a segunda em `SESSION_SECRET`.

4. Configure o Discord OAuth2.

- Crie uma aplicacao no Discord Developer Portal.
- Copie `Client ID` para `DISCORD_CLIENT_ID`.
- Para uso local simples, deixe `DISCORD_OAUTH_FLOW=implicit`; nesse modo o login nao usa `DISCORD_CLIENT_SECRET`.
- Para producao, use `DISCORD_OAUTH_FLOW=code` e copie `Client Secret` para `DISCORD_CLIENT_SECRET`.
- Adicione este redirect no Discord:

```text
http://localhost:4000/api/auth/discord/callback
```

- Mantenha o escopo `identify`.
- Se estiver usando `implicit`, o Discord retornara o token ao callback local e o Nexus criara uma sessao propria sem salvar o token do Discord.

5. Configure a whitelist inicial.

```env
AUTHORIZED_DISCORD_IDS=seu_discord_id:owner,discord_id_do_amigo:member
```

O app nao tem login por e-mail ou senha. Quem nao estiver nessa lista, ou na lista gerenciada depois pelo app, recebe acesso negado.

O owner decide individualmente quem pode ver midia, gerenciar midia, usar o bot
de vendas e gerenciar o estoque. Um usuario presente na whitelist nao recebe
essas permissoes automaticamente.

Owners possuem todas as permissoes. Admins continuam podendo criar keys,
gerenciar licencas e editar tags por HWID, mas apenas o owner altera acessos do
painel.

## Execucao

Web responsivo:

```bash
npm run dev
```

Depois abra:

```text
http://localhost:5173
```

Desktop com Electron:

```bash
npm run electron:dev
```

Build do frontend:

```bash
npm run build
npm run server:start
```

## Licencas do loader Roblox

A area **Usuarios > Licencas** e restrita a owners e admins. Ela permite criar,
editar, suspender, reativar e excluir usuarios licenciados, alem de:

- gerar uma key unica por Discord ID;
- usar os planos Lifetime, Mensal, Semanal e Teste, ou criar novos planos;
- definir expiracao e limite individual de resets de HWID;
- visualizar HWID, ultima utilizacao, IP aproximado e versao do loader;
- pesquisar por nome, Discord ID, key ou HWID;
- resetar o HWID e regenerar a key manualmente;
- suspender automaticamente uso suspeito em varios HWIDs ou redes.

O HWID e coletado no `nexus.lua`: o loader tenta `gethwid()` do executor, depois o
`ClientId` do Roblox e, se nenhum estiver disponivel, cria um identificador local
persistente. No primeiro uso valido ele e vinculado a key pela rota publica:

```text
POST /api/licenses/validate
```

As keys ficam cifradas com `APP_MASTER_KEY`, possuem hash separado para validacao
e aparecem completas somente para administradores autenticados. Em producao use
Postgres persistente (`DATABASE_URL`) e configure `TRUST_PROXY=true` no Render.

### Loader protegido no proprio site

Em **Usuarios > Loader protegido**, o owner/admin pode selecionar qualquer arquivo
`.lua` do script. O backend:

- cifra o source com AES-256-GCM antes de gravar no banco;
- publica um link fixo que retorna somente um bootstrap pequeno, nunca o source;
- valida key, HWID, expiracao e status antes de criar uma sessao;
- entrega o payload por um ticket aleatorio de uso unico, valido por 45 segundos;
- permite ativar outra versao e invalida tickets antigos automaticamente.

O endereco estavel e:

```text
https://nexus-zks.onrender.com/loader/nexus.lua
```

O loadstring aparece no proprio painel depois do primeiro upload. Esta protecao
nao usa API do Luarmor. Como qualquer script que precisa executar no executor,
o codigo precisa chegar ao cliente em algum momento e pode ser extraido por um
executor comprometido; o objetivo aqui e impedir que o site ou o link publico
exponham a source sem uma key/HWID validos.

## Anti-nuke do bot Discord

O anti-nuke monitora o Audit Log em tempo real e possui busca de seguranca para
canais, cargos, bans, webhooks, bots adicionados e alteracoes de cargos. Tambem
detecta rajadas de mensagens e spam de mencoes. A configuracao fica criptografada
no banco e volta automaticamente depois de reinicios ou deploys do Render.

Para o castigo funcionar, o cargo do bot precisa ficar acima dos cargos que ele
deve remover. O bot precisa de `View Audit Log`, `Manage Roles`, `Moderate Members`
e `Manage Messages`; habilite tambem `Kick Members` ou `Ban Members` se escolher
essas punicoes. O dono do servidor nunca pode ser punido por um bot do Discord.

O anti-spam por velocidade e mencoes funciona com `Guild Messages`. Para ler o
texto e detectar convites/repeticoes com precisao, habilite **Message Content
Intent** no Discord Developer Portal e configure:

```env
DISCORD_MESSAGE_CONTENT_INTENT=true
```

Para o anti-raid de entradas, habilite **Server Members Intent** e configure:

```env
DISCORD_GUILD_MEMBERS_INTENT=true
```

## Roblox

Quando a plataforma for Roblox, informe o Username e use a busca. O backend consulta as APIs publicas oficiais do Roblox para preencher:

- avatar
- username
- display name
- userId
- link do perfil

Se o Username nao existir, a interface informa que a conta nao foi encontrada.

## Gerador de Contas Roblox

A aba Gerador de Contas lista contas Roblox importadas por TXT em cards com avatar, username, display name, status e acoes para selecionar ou copiar os dados.

O status vem da presenca publica do Roblox:

- `Disponivel`: conta offline.
- `Em uso`: conta online, em jogo ou no Studio.

Selecionar ou copiar uma conta nao reserva a conta. Ela so aparece como em uso quando o Roblox informa que esta online.

Formato aceito no TXT:

```text
login: usuarioRoblox Senha: senhaDaConta
usuarioRoblox:senhaDaConta
```

A interface do estoque aparece somente para quem possui `sales.manage`. Tambem
existe importacao automatica local opcional:

```env
ROBLOX_ACCOUNTS_FILE=./data/roblox-accounts.txt
```

Nao envie arquivos TXT com contas reais para o GitHub. As senhas importadas ficam criptografadas no banco.

### Bot de vendas

O bot Discord configurado em `DISCORD_BOT_TOKEN` publica o comando `/conta`.
Somente IDs que receberam a permissao **Usar bot de vendas** no painel podem
executa-lo. O bot:

- reserva uma conta offline ainda nao entregue;
- envia usuario e senha somente na DM do solicitante;
- confirma publicamente apenas por resposta efemera;
- libera a reserva se a DM estiver fechada;
- impede entrega duplicada e registra auditoria sem salvar a senha no log;
- aplica intervalo de 60 segundos entre solicitacoes do mesmo usuario.

O banco ja guarda referencia e estado do pagamento por entrega. A cobranca
LivePix ainda fica desativada: ela deve ser conectada depois com webhook assinado
e confirmacao server-to-server antes de liberar a DM. Nunca confie apenas no
retorno do navegador para aprovar um PIX.

## Autenticador de codigos

A aba Codigos armazena autenticadores TOTP/2FA com segredo criptografado no banco. Ela aceita segredo Base32 manual ou URI `otpauth://`.

Recursos:

- codigo atual com contador
- copiar codigo com um clique
- tempo configuravel para troca do codigo, de 10 a 120 segundos
- excluir autenticador
- pesquisa por nome, emissor ou usuario

## Temp Email

A aba Temp Email cria caixas temporarias usando a API publica da Firemail.

Recursos:

- criar email temporario com prefixo e dominio
- copiar endereco com um clique
- atualizar caixa de entrada
- abrir mensagens recebidas
- copiar texto da mensagem ou links detectados
- excluir caixa temporaria

Nao precisa configurar API key no Render. A Firemail informa que a API e aberta, sem autenticacao e possui limite de 300 requisicoes por hora por IP. As caixas temporarias sao removidas apos 7 dias de inatividade. O Nexus mostra a atribuicao `Powered by Firemail` na interface.

O Nexus armazena apenas endereco, nome da caixa e metadados minimos. As mensagens sao buscadas na Firemail quando a aba e aberta ou atualizada.

## Midia com Cloudflare R2 ou Cloudinary

Para hospedar no Render, prefira Cloudflare R2 para imagens e videos nao dependerem do disco local do servidor.

```env
R2_ACCOUNT_ID=seu_account_id
R2_ENDPOINT=https://seu_account_id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=sua_access_key_id
R2_SECRET_ACCESS_KEY=sua_secret_access_key
R2_BUCKET=nexus-media
```

Quando as variaveis R2 existem, todo upload feito pela tela de Midia vai para o
R2. O backend serve os arquivos por `/api/images/:id/file`; essa rota exige
sessao Discord e a permissao `media.view`, entao o bucket nao precisa ficar
publico. Upload, exclusao e organizacao exigem `media.manage`.

Cloudinary ainda funciona como fallback se o R2 nao estiver configurado:

```env
CLOUDINARY_CLOUD_NAME=seu_cloud_name
CLOUDINARY_API_KEY=sua_api_key
CLOUDINARY_API_SECRET=sua_api_secret
CLOUDINARY_FOLDER=nexus
```

Se R2 e Cloudinary ficarem vazios, o app salva em `data/uploads` localmente.

## Produção

Em producao, use HTTPS no proxy ou servidor que ficar na frente do Node e configure:

```env
REQUIRE_HTTPS=true
TRUST_PROXY=true
CLIENT_URL=https://seu-dominio
API_PUBLIC_URL=https://seu-dominio
DISCORD_REDIRECT_URI=https://seu-dominio/api/auth/discord/callback
```

Adicione esse redirect HTTPS tambem no Discord Developer Portal.

### Render

Configuracao sugerida do Web Service:

```text
Runtime: Node
Build Command: npm install && npm run build
Start Command: npm run server:start
```

Variaveis principais no painel do Render:

```env
NODE_ENV=production
CLIENT_URL=https://seu-app.onrender.com
API_PUBLIC_URL=https://seu-app.onrender.com
DISCORD_CLIENT_ID=seu_client_id
DISCORD_REDIRECT_URI=https://seu-app.onrender.com/api/auth/discord/callback
DISCORD_OAUTH_FLOW=implicit
AUTHORIZED_DISCORD_IDS=seu_discord_id:owner,discord_id_do_amigo:member
APP_MASTER_KEY=copie_a_mesma_chave_do_seu_env_local
SESSION_SECRET=gere_ou_copie_um_segredo_longo
DATABASE_PATH=./data/nexus.db
CLOUDINARY_CLOUD_NAME=seu_cloud_name
CLOUDINARY_API_KEY=sua_api_key
CLOUDINARY_API_SECRET=sua_api_secret
CLOUDINARY_FOLDER=nexus
R2_ACCOUNT_ID=seu_account_id
R2_ENDPOINT=https://seu_account_id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=sua_access_key_id
R2_SECRET_ACCESS_KEY=sua_secret_access_key
R2_BUCKET=nexus-media
REQUIRE_HTTPS=true
TRUST_PROXY=true
```

Importante: no plano gratis do Render, o disco do Web Service nao deve ser usado como armazenamento permanente. R2/Cloudinary resolvem as midias, mas o SQLite em `./data/nexus.db` ainda pode ser perdido em reinicios, redeploys ou quando o servico dormir. Para guardar contas de forma permanente em producao, migre o banco para Postgres/Neon ou use um disco persistente pago.

### Neon Postgres

Para guardar as contas de forma permanente no plano gratis, crie um banco no Neon e adicione no Render:

```env
DATABASE_URL=sua_connection_string_do_neon
```

Quando `DATABASE_URL` existir, o Nexus usa Postgres/Neon automaticamente. Sem essa variavel, ele usa SQLite local em `DATABASE_PATH`.

## Observacoes de seguranca

- Senhas, logins e observacoes sao criptografados no banco.
- Tokens do Discord nao sao salvos.
- O historico nao registra senhas em texto puro.
- Backups exportados pelo endpoint do app sao criptografados.
- O dono da conta controla compartilhamentos e pode remover acesso.
