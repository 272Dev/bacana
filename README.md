# Nexus

Nexus e um cofre privado de contas para PC e mobile, com login exclusivo via Discord OAuth2, whitelist por Discord ID, senhas criptografadas e integracao com perfis publicos do Roblox.

## Stack

- Frontend: React + Vite, responsivo e instalavel como PWA.
- Desktop: Electron apontando para a interface web local.
- Backend: Node.js + Express.
- Banco: SQLite usando o modulo nativo do Node.
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

## Roblox

Quando a plataforma for Roblox, informe o Username e use a busca. O backend consulta as APIs publicas oficiais do Roblox para preencher:

- avatar
- username
- display name
- userId
- link do perfil

Se o Username nao existir, a interface informa que a conta nao foi encontrada.

## Imagens com Cloudinary

Para hospedar no Render, configure o Cloudinary para as imagens nao dependerem do disco local do servidor.

```env
CLOUDINARY_CLOUD_NAME=seu_cloud_name
CLOUDINARY_API_KEY=sua_api_key
CLOUDINARY_API_SECRET=sua_api_secret
CLOUDINARY_FOLDER=nexus
```

Quando essas variaveis existem, todo upload feito pela tela de Imagens ou pelo formulario de conta vai para o Cloudinary. Se elas ficarem vazias, o app continua usando `data/uploads` localmente.

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
REQUIRE_HTTPS=true
TRUST_PROXY=true
```

Importante: no plano gratis do Render, o disco do Web Service nao deve ser usado como armazenamento permanente. O Cloudinary resolve as imagens, mas o SQLite em `./data/nexus.db` ainda pode ser perdido em reinicios, redeploys ou quando o servico dormir. Para guardar contas de forma permanente em producao, migre o banco para Postgres/Supabase ou use um disco persistente pago.

## Observacoes de seguranca

- Senhas, logins e observacoes sao criptografados no banco.
- Tokens do Discord nao sao salvos.
- O historico nao registra senhas em texto puro.
- Backups exportados pelo endpoint do app sao criptografados.
- O dono da conta controla compartilhamentos e pode remover acesso.
