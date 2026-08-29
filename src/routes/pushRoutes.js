import express from "express";
import { verifyToken } from "../middlewares/authMiddleware.js";
import { subscribe, unsubscribe } from "../controllers/pushController.js";

const router = express.Router();

router.post("/subscribe", verifyToken, subscribe);
router.delete("/subscribe", verifyToken, unsubscribe);

export default router;
