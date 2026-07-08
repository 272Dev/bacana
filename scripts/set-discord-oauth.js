import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const envPath = '.env';

if (!fs.existsSync(envPath)) {
  console.error('.env nao encontrado.');
  process.exitCode = 1;
} else {
  const rl = readline.createInterface({ input, output });
  const clientId = (await rl.question('Cole o Client ID copiado do botao roxo: ')).trim();
  const clientSecret = (await rl.question('Cole o Client Secret copiado do botao roxo: ')).trim();
  rl.close();

  if (!/^\d{5,32}$/.test(clientId)) {
    console.error('Client ID invalido.');
    process.exitCode = 1;
  } else if (!clientSecret || clientSecret.length < 20) {
    console.error('Client Secret invalido.');
    process.exitCode = 1;
  } else {
    let content = fs.readFileSync(envPath, 'utf8');
    content = content.replace(/^DISCORD_CLIENT_ID=.*$/m, `DISCORD_CLIENT_ID=${clientId}`);
    content = content.replace(/^DISCORD_CLIENT_SECRET=.*$/m, `DISCORD_CLIENT_SECRET=${clientSecret}`);
    fs.writeFileSync(envPath, content);
    console.log('Discord OAuth2 salvo no .env.');
    console.log('Agora rode: npm run check:discord');
  }
}
