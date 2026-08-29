import { Church } from "../../models/Church.js";

// Feeds the login page's church dropdown. Public and unauthenticated by
// necessity — it is read before anyone can sign in.
//
// Only the fields the dropdown renders are exposed. Contact details, address
// and internal state stay out: this endpoint is world-readable, and the list
// of churches using the system is the most it should ever reveal.
export const getPublicChurches = async (req, res, next) => {
  try {
    const churches = await Church.find({ isActive: true, deletedAt: null })
      .select("name acronym logoUrl")
      .sort({ name: 1 })
      .lean();

    res.status(200).json({
      status: "Success",
      count: churches.length,
      data: churches,
    });
  } catch (error) {
    next(error);
  }
};
