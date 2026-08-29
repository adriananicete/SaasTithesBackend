import express from "express";
import { verifyToken } from "../middlewares/authMiddleware.js";
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
} from "../controllers/requestFormController.js";
import { addRfComment, getRfComments } from "../controllers/commentController.js";

const router = express.Router();

router.get("/", verifyToken, getAllRequestForms);
router.get("/:id/comments", verifyToken, getRfComments);
router.post("/:id/comments", verifyToken, addRfComment);
router.post("/", verifyToken, createRequestForm);
router.patch("/:id", verifyToken, updateRequestForm);
router.delete("/:id", verifyToken, deleteRequestForm);
router.patch("/:id/submit", verifyToken, submitRequestForm);
router.patch("/:id/validate", verifyToken, authorizeRoles("validator", "auditor", "admin"), validateRequestForm);
router.patch("/:id/approve", verifyToken, authorizeRoles("admin", "auditor", "pastor"), approveRequestForm);
router.patch("/:id/reject", verifyToken, authorizeRoles("admin", "validator", "auditor", "pastor"), rejectRequestForm);
router.patch("/:id/disburse", verifyToken, authorizeRoles("admin", "do"), disburseRequestForm);
router.patch("/:id/received", verifyToken, receivedRequestForm);

export default router;
