// Pure helpers for church scoping. Deliberately plain functions rather than
// Mongoose hooks or an AsyncLocalStorage plugin: a missed filter here is a
// cross-church financial data leak, and it must be visible in the diff at the
// call site rather than hidden behind infrastructure that a reviewer has to
// trust. They save typing `church: req.user.church`; they hide nothing.
//
// Usage:
//   Model.find(withChurch({ status: "pending" }, req))
//   Model.findOne(byIdInChurch(id, req))

// The bare filter for "everything belonging to the caller's church".
export const churchFilter = (req) => ({ church: req.user.church });

// Merges the church into an existing filter. Church wins over any `church`
// already in the filter, so a value from the request body can never widen it.
export const withChurch = (filter, req) => ({
  ...filter,
  church: req.user.church,
});

// For an id-addressed read or write. Using this instead of findById is what
// makes an ObjectId guessed from another church return "not found" rather than
// succeeding once the role check passes.
export const byIdInChurch = (id, req) => ({
  _id: id,
  church: req.user.church,
});

// Stamps the owning church onto a document being created.
export const stampChurch = (doc, req) => ({
  ...doc,
  church: req.user.church,
});
