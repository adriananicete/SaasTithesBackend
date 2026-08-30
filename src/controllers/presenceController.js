import { User } from "../models/User.js";
import { touchPresence, getOnlineIds } from "../services/presence.js";
import { withChurch } from "../utils/tenantScope.js";

// POST /api/presence/heartbeat
// Marks the caller active right now and returns everyone currently online in
// THIS CHURCH (id + name + avatarUrl + role) so the client can refresh its
// facepile in a single round-trip. Inactive/deactivated users are filtered out.
//
// The in-memory map in services/presence.js stays global — it only knows that
// an id beat recently, and splitting it per church would buy nothing. The
// filter on this lookup is what keeps another church's users out of the
// facepile.
export const heartbeat = async (req, res, next) => {
  try {
    touchPresence(req.user.id);
    const ids = getOnlineIds();
    const online = await User.find(withChurch({ _id: { $in: ids }, isActive: true }, req))
      .select("name avatarUrl role")
      .lean();
    res.json({ status: "success", online });
  } catch (error) {
    next(error);
  }
};
