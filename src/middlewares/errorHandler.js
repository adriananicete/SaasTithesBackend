// Catches requests that matched no route.
export const notFound = (req, res) => {
  res.status(404).json({ error: "Route not found" });
};

// Centralized error handler. Controllers forward errors here via next(error)
// so internal details are never sent to the client in production.
export const errorHandler = (err, req, res, next) => {
  // A response already started streaming (e.g. file exports) — let Express
  // close the connection rather than crashing on a double-send.
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;
  console.error(err);

  const isProd = process.env.NODE_ENV === "production";
  res.status(status).json({
    error:
      status === 500 && isProd
        ? "Internal Server Error"
        : err.message || "Internal Server Error",
  });
};
