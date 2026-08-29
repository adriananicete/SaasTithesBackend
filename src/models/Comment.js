import mongoose from "mongoose";

// Polymorphic comment thread (mirrors the Notification refModel/refId pattern).
// Scoped to RequestForm for now; the enum can grow to cover other entities.
const commentSchema = new mongoose.Schema(
  {
    refModel: {
      type: String,
      enum: ["RequestForm"],
      required: true,
    },
    refId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    text: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { timestamps: true },
);

commentSchema.index({ refModel: 1, refId: 1, createdAt: 1 });

export const Comment = mongoose.model("Comment", commentSchema);
