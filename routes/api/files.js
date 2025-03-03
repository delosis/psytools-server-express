const express = require("express");
const router = express.Router({ mergeParams: true }); // To access studyId from parent route
const config = require("../../config");
const path = require("path");
const fs = require("fs");
const { promisify } = require("util");
const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);
const jwt = require("jsonwebtoken");
const { User } = require("../../middleware/auth");

/* GET study files listing */
router.get("/", async (req, res) => {
  try {
    const { studyId } = req.params;
    const { role } = req.query;

    // Check study access
    if (!req.user.hasStudyAccess(studyId)) {
      return res.status(403).json({ error: "Unauthorized study access" });
    }

    // For non-admin roles, user can only access their role's folder
    const userAccess = req.user.studyAccess.find(
      (access) => access.studyId === studyId
    );
    if (
      role &&
      role !== "ADMIN" &&
      userAccess.role !== "STUDY_ADMIN" &&
      role !== userAccess.role
    ) {
      return res.status(403).json({ error: "Unauthorized role access" });
    }

    // Construct base path - look directly in the study folder
    let basePath = path.join(config.files.study.path, studyId);

    console.log("Looking for study files in:", basePath);

    // Check if directory exists
    if (!fs.existsSync(basePath)) {
      return res.status(200).json({ files: [] });
    }

    // Read directory recursively
    async function getFiles(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      const files = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(dir, entry.name);
          const relativePath = path.relative(basePath, fullPath);

          if (entry.isDirectory()) {
            const children = await getFiles(fullPath);
            return {
              name: entry.name,
              path: relativePath,
              type: "directory",
              children,
            };
          }

          const stats = await stat(fullPath);
          return {
            name: entry.name,
            path: relativePath,
            type: "file",
            size: stats.size,
            modified: stats.mtime,
          };
        })
      );

      return files;
    }

    const files = await getFiles(basePath);
    res.status(200).json({ files });
  } catch (error) {
    console.error("Error listing study files:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* GET specific study file */
router.get("/:role/:filepath(*)", async (req, res) => {
  try {
    // Check for token in query parameters (for direct downloads)
    let user = req.user;
    if (!user && req.query.token) {
      try {
        // Verify the token
        const decoded = jwt.verify(req.query.token, config.jwt.secret);

        // Create a user object with the same structure as the middleware would
        user = new User(decoded.userId, decoded.studyAccess || []);
      } catch (error) {
        console.error("Token verification error:", error);
        return res.status(401).json({ error: "Invalid token" });
      }
    }

    // If still no user, return unauthorized
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { studyId, role, filepath } = req.params;

    // Check study access
    if (!user.hasStudyAccess(studyId)) {
      return res.status(403).json({ error: "Unauthorized study access" });
    }

    // For non-admin roles, user can only access their role's folder
    const userAccess = user.studyAccess.find(
      (access) => access.studyId === studyId
    );
    if (
      role !== "ADMIN" &&
      userAccess.role !== "STUDY_ADMIN" &&
      role !== userAccess.role
    ) {
      return res.status(403).json({ error: "Unauthorized role access" });
    }

    // Prevent directory traversal
    const normalizedPath = path
      .normalize(filepath)
      .replace(/^(\.\.[\/\\])+/, "");

    // Try directly in the study folder first (this is the correct path)
    let filePath = path.join(config.files.study.path, studyId, normalizedPath);

    console.log("Looking for file at:", filePath);

    // If file doesn't exist, try with the role folder structure as fallback
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      filePath = path.join(
        config.files.study.path,
        studyId,
        role,
        normalizedPath
      );

      console.log("Fallback: Looking for file at:", filePath);

      // If still doesn't exist, return 404
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return res.status(404).json({ error: "File not found" });
      }
    }

    // Set content type based on file extension
    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      {
        ".pdf": "application/pdf",
        ".doc": "application/msword",
        ".docx":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel",
        ".xlsx":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".csv": "text/csv",
        ".txt": "text/plain",
        ".json": "application/json",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
      }[ext] || "application/octet-stream";

    // Get file stats to set content length
    const stats = await stat(filePath);
    console.log(`Serving study file: ${filePath}, size: ${stats.size} bytes`);

    // Set appropriate headers for file download
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", stats.size);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${path.basename(filePath)}"`
    );

    // Stream the file with appropriate error handling
    const fileStream = fs.createReadStream(filePath);

    fileStream.on("error", (error) => {
      console.error("Error streaming file:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Error streaming file" });
      } else {
        res.end();
      }
    });

    // Pipe the file to the response
    fileStream.pipe(res);
  } catch (error) {
    console.error("Error fetching study file:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
