import express from "express";
import { verifyToken } from "../middlewares/authMiddleware.js";
import { authorizeRoles } from "../middlewares/roleMiddleware.js";
import { getAuditLog } from "../controllers/auditController.js";

const router = express.Router();

router.get("/", verifyToken, authorizeRoles("admin", "auditor"), getAuditLog);

export default router;
