const ROBLOX_USERS_URL = 'https://users.roblox.com/v1/usernames/users';
const ROBLOX_THUMBNAILS_URL = 'https://thumbnails.roblox.com/v1/users/avatar-headshot';

export async function lookupRobloxUsername(username) {
  const cleanUsername = String(username || '').trim();
  if (!cleanUsername) {
    const error = new Error('Informe um Username do Roblox.');
    error.status = 400;
    throw error;
  }

  const userResponse = await fetch(ROBLOX_USERS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      usernames: [cleanUsername],
      excludeBannedUsers: true
    })
  });

  if (!userResponse.ok) {
    const error = new Error('Nao foi possivel consultar o Roblox agora.');
    error.status = 502;
    throw error;
  }

  const userPayload = await userResponse.json();
  const user = userPayload?.data?.[0];
  if (!user) {
    const error = new Error('Conta Roblox nao encontrada.');
    error.status = 404;
    throw error;
  }

  const avatarResponse = await fetch(
    `${ROBLOX_THUMBNAILS_URL}?userIds=${encodeURIComponent(user.id)}&size=150x150&format=Png&isCircular=false`
  );
  const avatarPayload = avatarResponse.ok ? await avatarResponse.json() : null;
  const avatarUrl = avatarPayload?.data?.[0]?.imageUrl || null;

  return {
    username: user.name,
    displayName: user.displayName,
    userId: String(user.id),
    profileUrl: `https://www.roblox.com/users/${user.id}/profile`,
    avatarUrl
  };
}
