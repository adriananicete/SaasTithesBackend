import express from "express";
import { verifyToken } from "../middlewares/authMiddleware.js";
import { heartbeat } from "../controllers/presenceController.js";

const router = express.Router();

router.post("/heartbeat", verifyToken, heartbeat);

export default router;
