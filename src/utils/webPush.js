import webpush from "web-push";
import { PushSubscription } from "../models/PushSubscription.js";

// Configure VAPID once at import. If keys are missing (e.g. local dev without
// env), push is simply disabled — it must never break the notification flow.
const PUBLIC = process.env.VAPID_PUBLIC_KEY;
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let enabled = false;
if (PUBLIC && PRIVATE) {
  try {
    webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
    enabled = true;
  } catch (err) {
    console.error("web-push VAPID config failed:", err?.message);
  }
}

// Send a push to every device a user has subscribed. Fire-and-forget: any
// failure is swallowed so the caller's notification flow is never disrupted.
// Dead subscriptions (410 Gone / 404) are pruned.
export const sendPushToUser = async (userId, payload) => {
  if (!enabled || !userId) return;
  try {
    const subs = await PushSubscription.find({ userId });
    if (subs.length === 0) return;

    const body = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: sub.keys },
            body,
          );
        } catch (err) {
          if (err?.statusCode === 410 || err?.statusCode === 404) {
            await PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
          }
        }
      }),
    );
  } catch (err) {
    console.error("sendPushToUser failed:", err?.message);
  }
};
