import { User } from "../models/User.js";
import { touchPresence, getOnlineIds } from "../services/presence.js";

// POST /api/presence/heartbeat
// Marks the caller active right now and returns everyone currently online
// (id + name + avatarUrl + role) so the client can refresh its facepile in a
// single round-trip. Inactive/deactivated users are filtered out.
export const heartbeat = async (req, res, next) => {
  try {
    touchPresence(req.user.id);
    const ids = getOnlineIds();
    const online = await User.find({ _id: { $in: ids }, isActive: true })
      .select("name avatarUrl role")
      .lean();
    res.json({ status: "success", online });
  } catch (error) {
    next(error);
  }
};
