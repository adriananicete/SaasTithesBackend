import mongoose from "mongoose";

export async function connectDB() {
  try {
    const connect = await mongoose.connect(process.env.CONNECTION_STRING);
    console.log(`Database Connected: ${connect.connection.host}`);
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
}
