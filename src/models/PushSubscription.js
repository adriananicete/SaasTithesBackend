import mongoose from "mongoose";

// One row per browser/device a user has enabled push on. A user can have many
// (phone + laptop, etc.). `endpoint` is unique so re-subscribing upserts.
const pushSubscriptionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
  },
  { timestamps: true },
);

export const PushSubscription = mongoose.model(
  "PushSubscription",
  pushSubscriptionSchema,
);
