const ROBLOX_USERS_URL = 'https://users.roblox.com/v1/usernames/users';
const ROBLOX_THUMBNAILS_URL = 'https://thumbnails.roblox.com/v1/users/avatar-headshot';
const ROBLOX_BATCH_SIZE = 100;

function normalizeUsername(username) {
  return String(username || '').trim();
}

function mapPublicRobloxUser(user, avatarUrl = null) {
  return {
    username: user.name,
    displayName: user.displayName,
    userId: String(user.id),
    profileUrl: `https://www.roblox.com/users/${user.id}/profile`,
    avatarUrl
  };
}

export async function lookupRobloxUsernames(usernames, { excludeBannedUsers = false } = {}) {
  const cleanUsernames = [...new Set(
    usernames
      .map(normalizeUsername)
      .filter(Boolean)
  )];
  const result = new Map();

  for (let index = 0; index < cleanUsernames.length; index += ROBLOX_BATCH_SIZE) {
    const batch = cleanUsernames.slice(index, index + ROBLOX_BATCH_SIZE);
    const userResponse = await fetch(ROBLOX_USERS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usernames: batch,
        excludeBannedUsers
      })
    });

    if (!userResponse.ok) {
      const error = new Error('Nao foi possivel consultar o Roblox agora.');
      error.status = 502;
      throw error;
    }

    const userPayload = await userResponse.json();
    const users = userPayload?.data || [];
    const ids = users.map((user) => user.id).filter(Boolean);
    let avatars = new Map();

    if (ids.length > 0) {
      const avatarResponse = await fetch(
        `${ROBLOX_THUMBNAILS_URL}?userIds=${encodeURIComponent(ids.join(','))}&size=150x150&format=Png&isCircular=false`
      );
      const avatarPayload = avatarResponse.ok ? await avatarResponse.json() : null;
      avatars = new Map((avatarPayload?.data || []).map((item) => [String(item.targetId), item.imageUrl || null]));
    }

    for (const user of users) {
      const publicUser = mapPublicRobloxUser(user, avatars.get(String(user.id)) || null);
      result.set(publicUser.username.toLowerCase(), publicUser);
    }
  }

  return result;
}

export async function lookupRobloxUsername(username) {
  const cleanUsername = normalizeUsername(username);
  if (!cleanUsername) {
    const error = new Error('Informe um Username do Roblox.');
    error.status = 400;
    throw error;
  }

  const users = await lookupRobloxUsernames([cleanUsername], { excludeBannedUsers: true });
  const user = users.get(cleanUsername.toLowerCase());
  if (!user) {
    const error = new Error('Conta Roblox nao encontrada.');
    error.status = 404;
    throw error;
  }

  return user;
}
