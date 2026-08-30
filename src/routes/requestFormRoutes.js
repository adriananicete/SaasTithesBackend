import express from "express";
import { verifyToken } from "../middlewares/authMiddleware.js";
import { blockInactiveChurch } from '../middlewares/tenantMiddleware.js';
import { authorizeRoles } from "../middlewares/roleMiddleware.js";
import {
  approveRequestForm,
  createRequestForm,
  deleteRequestForm,
  disburseRequestForm,
  getAllRequestForms,
  receivedRequestForm,
  rejectRequestForm,
  submitRequestForm,
  updateRequestForm,
  validateRequestForm,
  addRfAttachments,
  removeRfAttachment,
} from "../controllers/requestFormController.js";
import { addRfComment, getRfComments } from "../controllers/commentController.js";
import {
  uploadRfAttachments,
  handleAttachmentUploadError,
} from "../middlewares/uploadMiddleware.js";

const router = express.Router();

// Every route here belongs to one church. Applied at router level so a route
// added later cannot skip the guard; the per-route verifyToken calls below are
// now redundant but harmless, and left in place as a second line of defence.
router.use(verifyToken, blockInactiveChurch);

router.get("/", verifyToken, getAllRequestForms);
router.get("/:id/comments", verifyToken, getRfComments);
router.post("/:id/comments", verifyToken, addRfComment);
router.post("/", verifyToken, createRequestForm);
router.patch("/:id", verifyToken, updateRequestForm);
router.delete("/:id", verifyToken, deleteRequestForm);
// Supporting documents. Requester-only and draft-only, the same rules as
// editing the form itself.
router.post(
  "/:id/attachments",
  verifyToken,
  uploadRfAttachments.array("attachments", 5),
  handleAttachmentUploadError,
  addRfAttachments,
);
router.delete("/:id/attachments", verifyToken, removeRfAttachment);

router.patch("/:id/submit", verifyToken, submitRequestForm);
router.patch("/:id/validate", verifyToken, authorizeRoles("validator", "auditor", "admin"), validateRequestForm);
router.patch("/:id/approve", verifyToken, authorizeRoles("admin", "auditor", "pastor"), approveRequestForm);
router.patch("/:id/reject", verifyToken, authorizeRoles("admin", "validator", "auditor", "pastor"), rejectRequestForm);
router.patch("/:id/disburse", verifyToken, authorizeRoles("admin", "do"), disburseRequestForm);
router.patch("/:id/received", verifyToken, receivedRequestForm);

export default router;
