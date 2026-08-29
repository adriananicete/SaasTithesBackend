import express from "express";
import { verifyToken } from "../middlewares/authMiddleware.js";
import { globalSearch } from "../controllers/searchController.js";

const router = express.Router();

router.get("/", verifyToken, globalSearch);

export default router;
