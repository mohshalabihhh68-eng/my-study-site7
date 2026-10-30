/**
 * Vercel serverless entry — re-exports the Express app.
 * All /api/* routes are handled by server.js
 */
import app from "../server.js";

export default app;
