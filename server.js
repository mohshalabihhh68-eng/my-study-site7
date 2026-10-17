
import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:8080"
}));

app.use(express.json());

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    message: "Course platform server is running"
  });
});

// قائمة الكورسات من واجهة API المصرح باستخدامها
app.get("/api/courses", async (req, res) => {
  const apiUrl = process.env.COURSES_API_URL;
  const apiToken = process.env.COURSES_API_TOKEN;

  if (!apiUrl || !apiToken) {
    return res.status(503).json({
      error: "Server API configuration is missing"
    });
  }

  try {
    const response = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        Accept: "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      return res.status(502).json({
        error: "Upstream API request failed"
      });
    }

    const data = await response.json();
    res.json(data);
  } catch {
    res.status(502).json({
      error: "Could not connect to courses API"
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
