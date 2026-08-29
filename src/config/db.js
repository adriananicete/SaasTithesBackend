import mongoose from "mongoose";

// Production and development each get their own Atlas cluster so testing never
// runs against real church data. CONNECTION_STRING stays as a local-Mongo override.
const resolveConnectionString = () => {
  const isProduction = process.env.NODE_ENV === "production";
  const envSpecific = isProduction
    ? process.env.PRODUCTION_CONNECTION_STRING
    : process.env.DEVELOPMENT_CONNECTION_STRING;

  return envSpecific || process.env.CONNECTION_STRING;
};

export async function connectDB() {
  const environment = process.env.NODE_ENV || "development";
  const connectionString = resolveConnectionString();

  if (!connectionString) {
    console.log(
      `No connection string configured for NODE_ENV=${environment}. Set PRODUCTION_CONNECTION_STRING, DEVELOPMENT_CONNECTION_STRING, or CONNECTION_STRING.`
    );
    process.exit(1);
  }

  try {
    const connect = await mongoose.connect(connectionString);
    // Host + database name only — never the connection string, it carries credentials.
    console.log(
      `Database Connected [${environment}]: ${connect.connection.host}/${connect.connection.name}`
    );
  } catch (error) {
    console.log(error);
    process.exit(1);
  }
}
