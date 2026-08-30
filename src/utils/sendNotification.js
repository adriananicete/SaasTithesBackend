import { Notification } from "../models/Notification.js"
import { User } from "../models/User.js";
import { emitToUser } from "../services/realtime.js";
import { sendPushToUser } from "./webPush.js";

// Frontend deep-link target for a notification, so tapping the phone push
// opens the related record (same ?focus= pattern the pages already consume).
const PUSH_ROUTE = { Tithes: "/tithes", RequestForm: "/request-form", Voucher: "/voucher" };
const pushUrl = (refModel, refId) => {
    const base = PUSH_ROUTE[refModel];
    return base && refId ? `${base}?focus=${refId}` : "/dashboard";
};

export const sendNotification = async ({userId, message, type, refId, refModel }) => {
    const createNotif = new Notification({
        userId,
        message,
        type,
        refId,
        refModel
    });

    await createNotif.save();

    emitToUser(userId, "notification:new", createNotif);

    // Phone push for when the app is closed (no-op if user has no subscription
    // or VAPID isn't configured; never throws).
    sendPushToUser(userId, {
        title: "JOSCM Tithes",
        body: message,
        url: pushUrl(refModel, refId),
    });

    return createNotif
};

// Fan out the same notification to every active user in the given roles,
// WITHIN ONE CHURCH. Pass excludeUserId to skip the actor (e.g., admin
// validating their own submission shouldn't notify themselves through the
// validator-role path).
//
// `church` is required. Without it this query returned every user in every
// church holding the role, so one church approving a request notified every
// other church's validators — a leak that no endpoint would ever show, because
// nothing lets you read someone else's notifications. A missing church sends
// NOTHING and says so loudly: an absent notification is recoverable, a
// cross-church one is not.
export const sendNotificationToRoles = async ({ church, roles, message, type, refId, refModel, excludeUserId }) => {
    if (!Array.isArray(roles) || roles.length === 0) return [];
    if (!church) {
        console.error(`sendNotificationToRoles skipped: no church (roles: ${roles.join(",")})`);
        return [];
    }

    const recipients = await User.find({
        church,
        role: { $in: roles },
        isActive: true,
    }).select("_id");

    const targets = recipients
        .map((u) => u._id)
        .filter((id) => !excludeUserId || id.toString() !== excludeUserId.toString());

    return Promise.all(
        targets.map((userId) =>
            sendNotification({ userId, message, type, refId, refModel })
        )
    );
};
