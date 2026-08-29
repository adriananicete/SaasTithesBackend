import express from "express";
import { verifyToken } from "../middlewares/authMiddleware.js";
import { blockInactiveChurch } from '../middlewares/tenantMiddleware.js';
import { globalSearch } from "../controllers/searchController.js";

const router = express.Router();

// Every route here belongs to one church. Applied at router level so a route
// added later cannot skip the guard; the per-route verifyToken calls below are
// now redundant but harmless, and left in place as a second line of defence.
router.use(verifyToken, blockInactiveChurch);

router.get("/", verifyToken, globalSearch);

export default router;
