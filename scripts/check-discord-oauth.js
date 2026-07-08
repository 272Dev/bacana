import { config, getMissingRuntimeConfig } from '../server/src/config.js';

const missing = getMissingRuntimeConfig();
if (missing.length > 0) {
  console.log(`Configuracao pendente: ${missing.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log(`Client ID usado: ${config.discord.clientId}`);
  console.log(`Fluxo OAuth2: ${config.discord.oauthFlow}`);
  console.log(`Client Secret: configurado com ${config.discord.clientSecret.length} caracteres`);
  console.log(`Redirect URI: ${config.discord.redirectUri}`);

  if (config.discord.oauthFlow === 'implicit') {
    console.log('Modo implicit ativo: o login nao usa Client Secret.');
    console.log('Configuracao local OK. Teste entrando por http://localhost:5173');
  } else {
  async function tryToken(label, options) {
    const response = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      ...options
    });
    const payload = await response.json().catch(() => ({}));
    return {
      label,
      ok: response.ok,
      status: response.status,
      error: payload.error,
      errorDescription: payload.error_description
    };
  }

  const auth = Buffer.from(`${config.discord.clientId}:${config.discord.clientSecret}`).toString('base64');
  const basicResult = await tryToken('basic-auth', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'identify'
    })
  });

  const formResult = await tryToken('form-body', {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'identify',
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret
    })
  });

  const result = basicResult.ok ? basicResult : formResult;

  if (!result.ok) {
    console.log('Discord recusou o Client ID + Client Secret.');
    console.log(`Teste basic-auth: ${basicResult.status} ${basicResult.error || ''}`.trim());
    console.log(`Teste form-body: ${formResult.status} ${formResult.error || ''}`.trim());
    console.log('');
    console.log('O que corrigir no Discord Developer Portal:');
    console.log('1. Abra a MESMA aplicacao desse Client ID.');
    console.log('2. Va em OAuth2 > Client Information.');
    console.log('3. Deixe Public Client DESLIGADO e salve se aparecer Save Changes.');
    console.log('4. Clique Reset Secret, copie pelo botao roxo e cole de novo no .env.');
    process.exitCode = 1;
  } else {
    console.log('Discord OAuth2 OK. Client ID e Client Secret combinam.');
  }
  }
}
