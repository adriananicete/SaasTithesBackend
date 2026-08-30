import cloudinary from "../config/cloudinary.js";

// One place that knows how Cloudinary reports a failure, and one way to delete
// an asset that has been replaced.
//
// Deleting an old avatar or logo is genuinely non-fatal — the new image is
// already uploaded and saved, and refusing the request because the previous
// file lingered would be worse than the lingering file. But "non-fatal" was
// being written as `catch (e) { /* non-fatal */ }` in six places, which is not
// the same thing: a failed delete orphaned a file in Cloudinary permanently,
// with nothing written down anywhere. Non-fatal means carry on, not say nothing.

// The SDK reports failure two different ways, and reading the wrong one prints
// `undefined` — which is exactly the bug §14 item 11 was:
//
//   api.*      → nested:  { error: { message, http_code } }, top-level .message undefined
//   uploader.* → flat:    { message, http_code }
//
// Anything that logs a Cloudinary failure goes through here so neither shape is
// forgotten. NEVER log the error object itself: the SDK attaches
// request_options.auth to it, which is the API key and secret.
export const cloudinaryErrorText = (error) => {
  const detail = error?.error ?? error;
  const status = detail?.http_code ?? error?.http_code;
  const message = detail?.message ?? "unknown error";
  return `${status ?? "no status"}: ${message}`;
};

// Delete one asset that is being replaced or removed. Returns whether the file
// is gone; callers carry on either way.
//
// `uploader.destroy` does NOT throw for an id that is not there — it resolves
// with { result: "not found" }, which is the outcome we wanted anyway, so it is
// treated as success and stays quiet. It throws only for a real problem: a bad
// parameter, auth, the network. Those are the ones worth a line in the log.
export const destroyCloudinaryAsset = async (publicId, context) => {
  if (!publicId) return true;

  try {
    const res = await cloudinary.uploader.destroy(publicId);
    if (res?.result === "ok" || res?.result === "not found") return true;

    // Some other result — 'rate limited' and friends. Not an exception, and
    // previously invisible because nothing looked at what came back.
    console.error(
      `Cloudinary delete did not succeed for ${context} (${publicId}): ${res?.result ?? "no result"}`,
    );
    return false;
  } catch (error) {
    console.error(
      `Cloudinary delete failed for ${context} (${publicId}) — ${cloudinaryErrorText(error)}`,
    );
    return false;
  }
};
