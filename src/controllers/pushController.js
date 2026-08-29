import { PushSubscription } from "../models/PushSubscription.js";

// POST /api/push/subscribe — save (upsert) the browser's push subscription for
// the current user. Body: { endpoint, keys: { p256dh, auth } }.
const subscribe = async (req, res, next) => {
  try {
    const { endpoint, keys } = req.body || {};
    if (!endpoint || !keys?.p256dh || !keys?.auth)
      return res.status(400).json({ error: "Invalid subscription" });

    await PushSubscription.findOneAndUpdate(
      { endpoint },
      { userId: req.user.id, endpoint, keys },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    res.status(201).json({ status: "Success", message: "Subscribed" });
  } catch (error) {
    next(error);
  }
};

// DELETE /api/push/subscribe — remove a subscription by endpoint.
const unsubscribe = async (req, res, next) => {
  try {
    const { endpoint } = req.body || {};
    if (!endpoint) return res.status(400).json({ error: "endpoint required" });
    await PushSubscription.deleteOne({ endpoint, userId: req.user.id });
    res.status(200).json({ status: "Success", message: "Unsubscribed" });
  } catch (error) {
    next(error);
  }
};

export { subscribe, unsubscribe };
