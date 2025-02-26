const express = require("express");
const path = require("path");
const logger = require("morgan");
const cors = require("cors");
const config = require("./config");
const fs = require("fs");
const { authenticateUser } = require("./middleware/auth");

const apiRouter = require("./routes/api");

const app = express();

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Create a write stream for access logs
const accessLogStream = fs.createWriteStream(path.join(logsDir, "access.log"), {
  flags: "a",
});

// Configure morgan logging
// Log to file in combined format (Apache style)
app.use(logger("combined", { stream: accessLogStream }));
// Also log to console in dev format for development visibility
app.use(logger("dev"));

// Configure Express to handle JSON
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Set default content type for all responses to JSON, except for file downloads
app.use((req, res, next) => {
  // Skip JSON handling for file download routes
  if (
    req.path.includes("/datasets/") ||
    (req.path.includes("/studies/") && req.path.includes("/files/"))
  ) {
    console.log("Skipping JSON handling for file route:", req.path);
    return next();
  }

  console.log("Setting up JSON handling for route:", req.path);

  // For all other routes, ensure proper JSON handling
  const originalJson = res.json;
  res.json = function (obj) {
    console.log("Pre-processing JSON response:", JSON.stringify(obj, null, 2));

    // Ensure null is converted to empty array for 'data' properties
    if (obj && typeof obj === "object") {
      if (obj.data === null) {
        console.log("Converting null data to empty array");
        obj.data = [];
      }
      if (Array.isArray(obj.data)) {
        console.log("Processing array data items");
        obj.data = obj.data.map((item) => {
          if (item === null) {
            console.log("Converting null item to empty object");
            return {};
          }
          return item;
        });
      }
    }

    console.log("Final processed JSON response:", JSON.stringify(obj, null, 2));
    return originalJson.call(this, obj);
  };

  // Ensure proper content type
  console.log("Setting Content-Type to application/json");
  res.setHeader("Content-Type", "application/json");
  next();
});

// Configure CORS to only accept requests from our Azure Functions
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS
      ? process.env.ALLOWED_ORIGINS.split(",")
      : "*",
  })
);

// Health check endpoint (no auth required)
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

// Debug middleware to log all requests
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// Authentication middleware
app.use(authenticateUser);

// Routes
app.use("/api", apiRouter);

// Error handler
app.use((err, req, res, next) => {
  // Log error details to error log file
  const errorLogStream = fs.createWriteStream(path.join(logsDir, "error.log"), {
    flags: "a",
  });

  const errorLog = {
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url,
    ip: req.ip,
    error: {
      message: err.message,
      stack: err.stack,
    },
  };

  errorLogStream.write(JSON.stringify(errorLog) + "\n");
  console.error("Error:", err.stack);

  // Don't expose error details in production
  res.status(500).json({
    success: false,
    error:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

module.exports = app;
