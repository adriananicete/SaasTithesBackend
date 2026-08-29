import jwt from "jsonwebtoken";

export const verifyToken = (req, res, next) => {
  try {
    // Prefer the httpOnly cookie; fall back to the Authorization header so
    // header-based clients keep working during the cookie-auth transition.
    let token = req.cookies?.access_token;

    if (!token) {
      const tokenHeader = req.headers.authorization;
      if (tokenHeader && tokenHeader.startsWith("Bearer ")) {
        token = tokenHeader.split(" ")[1];
      }
    }

    if (!token)
      return res.status(401).json({ error: "No token, Access Denied!" });

    req.user = jwt.verify(token, process.env.JWT_SECRET_KEY);

    next();
  } catch (error) {
    res.status(401).json({ error: "Invalid Token" });
  }
};
