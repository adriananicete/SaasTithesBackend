import mongoose from "mongoose";

// True if the value is a well-formed Mongo ObjectId.
export const isValidObjectId = (id) => mongoose.Types.ObjectId.isValid(id);

// Parses a date input; returns a Date, or null if missing/invalid.
export const parseDate = (value) => {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
};
