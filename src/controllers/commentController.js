import mongoose from "mongoose";
import { Comment } from "../models/Comment.js";
import { RequestForm } from "../models/RequestForm.js";
import { buildRfScope } from "./requestFormController.js";
import { sendNotification } from "../utils/sendNotification.js";

// Workflow participants = any staff role; a member only on their own RF.
const canComment = (user, rf) =>
  user.role !== "member" || rf.requestedBy?.toString() === user.id;

// Fetch the RF only if it's within the user's visibility scope (reuses the
// same row-scoping as the table) so members can't read others' threads.
const findVisibleRf = (user, id) =>
  RequestForm.findOne({ _id: id, ...buildRfScope(user) });

const getRfComments = async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });

    const rf = await findVisibleRf(req.user, id);
    if (!rf) return res.status(404).json({ error: "Request form not found" });

    const comments = await Comment.find({ refModel: "RequestForm", refId: id })
      .sort({ createdAt: 1 })
      .populate("authorId", "name role avatarUrl");

    res.status(200).json({ status: "Success", count: comments.length, data: comments });
  } catch (error) {
    next(error);
  }
};

const addRfComment = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id))
      return res.status(400).json({ error: "Invalid ID" });
    if (!text || !String(text).trim())
      return res.status(400).json({ error: "Comment text is required" });

    const rf = await findVisibleRf(req.user, id);
    if (!rf) return res.status(404).json({ error: "Request form not found" });

    if (!canComment(req.user, rf))
      return res
        .status(403)
        .json({ error: "You cannot comment on this request form" });

    const comment = await Comment.create({
      refModel: "RequestForm",
      refId: id,
      authorId: req.user.id,
      text: String(text).trim(),
    });
    await comment.populate("authorId", "name role avatarUrl");

    // Notify everyone who has acted on the RF, minus the comment author.
    const participantIds = [
      rf.requestedBy,
      rf.validatedBy,
      rf.approvedBy,
      rf.disbursedBy,
      rf.receivedBy,
    ]
      .filter(Boolean)
      .map((x) => x.toString());

    const recipients = [...new Set(participantIds)].filter(
      (uid) => uid !== req.user.id,
    );

    await Promise.all(
      recipients.map((userId) =>
        sendNotification({
          userId,
          message: `New comment on ${rf.rfNo} from ${comment.authorId.name}`,
          type: "info",
          refId: rf._id,
          refModel: "RequestForm",
        }),
      ),
    );

    res.status(201).json({ status: "Success", message: "Comment added", data: comment });
  } catch (error) {
    next(error);
  }
};

export { getRfComments, addRfComment };
