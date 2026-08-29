// In-memory presence tracker. A user counts as "online" if they have sent a
// heartbeat within PRESENCE_WINDOW_MS.
//
// This is deliberately heartbeat/polling based rather than Socket.IO: the
// production frontend runs behind the Vercel same-origin proxy, which does not
// carry a WebSocket, so the socket is disabled in prod (see the client's
// services/socket.js) and only plain HTTP reaches the backend reliably.
//
// State lives in memory, so it resets on a server restart/redeploy and simply
// repopulates within one heartbeat interval. That's fine for a "who's online"
// indicator — it never needs to be durable.

const lastSeen = new Map(); // userId (string) -> epoch ms of last heartbeat

// Window must be comfortably larger than the client's heartbeat interval so a
// single dropped/slow beat doesn't flicker a user offline. Client beats ~20s.
export const PRESENCE_WINDOW_MS = 45 * 1000;

export const touchPresence = (userId) => {
  if (!userId) return;
  lastSeen.set(String(userId), Date.now());
};

// Returns the ids seen within the window and prunes anything older so the map
// can't grow unbounded across the app's lifetime.
export const getOnlineIds = (windowMs = PRESENCE_WINDOW_MS) => {
  const cutoff = Date.now() - windowMs;
  const ids = [];
  for (const [id, seen] of lastSeen) {
    if (seen >= cutoff) ids.push(id);
    else lastSeen.delete(id);
  }
  return ids;
};
