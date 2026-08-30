import express from "express";
import { verifyToken } from "../middlewares/authMiddleware.js";
import { blockInactiveChurch } from "../middlewares/tenantMiddleware.js";
import { authorizeRoles } from "../middlewares/roleMiddleware.js";
import { uploadChurchLogo, handleLogoUploadError } from "../middlewares/uploadMiddleware.js";
import {
  getMyChurch,
  updateMyChurchProfile,
  setMyChurchLogo,
  removeMyChurchLogo,
} from "../controllers/churchProfileController.js";
import { ROLES } from "../constants/roles.js";

const router = express.Router();

// Every route here belongs to one church, and to the caller's own church only —
// none of them takes a church id at all.
router.use(verifyToken, blockInactiveChurch);

// Read is open to every role: the header, sidebar and dashboard all render the
// church's name and logo, so a member needs it as much as an admin does.
router.get("/me", getMyChurch);

router.patch("/me", authorizeRoles(ROLES.ADMIN), updateMyChurchProfile);
router.patch(
  "/me/logo",
  authorizeRoles(ROLES.ADMIN),
  uploadChurchLogo.single("logo"),
  handleLogoUploadError,
  setMyChurchLogo,
);
router.delete("/me/logo", authorizeRoles(ROLES.ADMIN), removeMyChurchLogo);

export default router;
