const express = require("express");
const router = express.Router();
const { Pool } = require("pg");
const config = require("../../config");
const { ROLES } = require("../../constants");
const path = require("path");
const fs = require("fs");
const { promisify } = require("util");
const stat = promisify(fs.stat);
const jwt = require("jsonwebtoken");
const { User } = require("../../middleware/auth");

const pool = new Pool(config.db);

/* GET dataset files listing with metadata */
router.get("/", async (req, res) => {
  try {
    if (!req.user.permissions.includes("READ_DATASETS")) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const queryParts = req.user.studyAccess.map((access, idx) => {
      const param = `$${idx + 1}`;
      if (ROLES[access.role] === ROLES.STUDY_ADMIN) {
        return `(df.study_id = ${param})`;
      } else if (access.role === "SAMPLE_ADMIN") {
        return `(df.study_id = ${param} AND 
          (df.sample_id IS NULL OR df.sample_id::text = ANY($${
            idx + 1 + req.user.studyAccess.length
          }::text[])))`;
      }
      return `(df.study_id = ${param})`;
    });

    // Prepare parameters with proper type casting for arrays
    const params = [...req.user.studyAccess.map((access) => access.studyId)];

    // For sample admins, we need to handle the array parameters differently
    // First, let's modify the query parts to use a different approach
    const sampleAdminQueryParts = req.user.studyAccess
      .filter((access) => access.role === "SAMPLE_ADMIN")
      .map((access, idx) => {
        // For each sample ID, create a separate condition
        if (Array.isArray(access.sampleIds) && access.sampleIds.length > 0) {
          const sampleConditions = access.sampleIds.map(
            (sampleId, sampleIdx) => {
              const paramIndex = params.length + 1;
              params.push(sampleId.toString()); // Add the sample ID as a string parameter
              return `(df.sample_id::text = $${paramIndex})`;
            }
          );

          // Join all sample conditions with OR
          return `(df.study_id = $${
            req.user.studyAccess.indexOf(access) + 1
          } AND (df.sample_id IS NULL OR ${sampleConditions.join(" OR ")}))`;
        } else {
          // If no sample IDs, just check the study ID
          return `(df.study_id = $${req.user.studyAccess.indexOf(access) + 1})`;
        }
      });

    // Replace the sample admin query parts in the original query parts
    const updatedQueryParts = req.user.studyAccess.map((access, idx) => {
      if (access.role === "SAMPLE_ADMIN") {
        const sampleAdminIndex = req.user.studyAccess
          .filter((a) => a.role === "SAMPLE_ADMIN")
          .indexOf(access);
        return sampleAdminQueryParts[sampleAdminIndex];
      } else {
        return `(df.study_id = $${idx + 1})`;
      }
    });

    const updatedWhereClause = updatedQueryParts.join(" OR ");

    console.log("Updated where clause:", updatedWhereClause);
    console.log("Parameters:", params);

    const query = `
      WITH latest_task_instances AS (
        SELECT DISTINCT ON (task_id)
          task_id,
          title as task_title,
          summary as task_summary,
          description as task_description,
          language_code
        FROM fw_psy_task_instance
        ORDER BY task_id, file_modified DESC
      )
      SELECT 
        df.dataset_file_id as id,
        df.study_id,
        df.task_id,
        ti.task_title,
        ti.task_summary,
        ti.task_description,
        ti.language_code as task_language,
        df.digest_def_id,
        df.sample_id,
        s.sample_code,
        s.sample_name,
        df.filename,
        df.updated_time
      FROM fw_psy_dataset_file df
      -- Get latest task instance info if available
      LEFT JOIN latest_task_instances ti ON df.task_id = ti.task_id
      -- Get sample info if available
      LEFT JOIN fw_psy_sample s ON df.sample_id = s.sample_id
      WHERE ${updatedWhereClause}
      ORDER BY df.updated_time DESC
    `;

    const results = await pool.query(query, params);

    // Add file system metadata
    const filesWithMeta = await Promise.all(
      results.rows.map(async (file) => {
        const filePath = path.join(config.files.datasets.path, file.filename);
        try {
          const stats = await stat(filePath);
          return {
            ...file,
            size: stats.size,
            exists: true,
            last_modified: stats.mtime,
            // Add formatted sample info if available
            sample: file.sample_id
              ? {
                  id: file.sample_id,
                  code: file.sample_code,
                  name: file.sample_name,
                }
              : null,
            // Remove redundant fields after restructuring
            sample_id: undefined,
            sample_code: undefined,
            sample_name: undefined,
          };
        } catch (err) {
          return {
            ...file,
            exists: false,
            sample: file.sample_id
              ? {
                  id: file.sample_id,
                  code: file.sample_code,
                  name: file.sample_name,
                }
              : null,
            sample_id: undefined,
            sample_code: undefined,
            sample_name: undefined,
          };
        }
      })
    );

    res.status(200).json(filesWithMeta);
  } catch (error) {
    console.error("Error fetching dataset files:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* GET specific dataset file */
router.get("/:fileId", async (req, res) => {
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

    // Check permissions
    if (!user.permissions.includes("READ_DATASETS")) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const fileId = req.params.fileId;
    console.log(
      "Fetching dataset file with ID:",
      fileId,
      "Type:",
      typeof fileId
    );

    const queryParts = user.studyAccess.map((access, idx) => {
      const param = `$${idx + 2}`; // Changed to idx + 2 since $1 is now fileId
      if (ROLES[access.role] === ROLES.STUDY_ADMIN) {
        return `(df.study_id = ${param})`;
      } else if (access.role === "SAMPLE_ADMIN") {
        return `(df.study_id = ${param} AND 
          (df.sample_id IS NULL OR df.sample_id::text = ANY($${
            idx + 2 + user.studyAccess.length
          }::text[])))`;
      }
      return `(df.study_id = ${param})`;
    });

    // Prepare parameters with proper type casting for arrays
    const params = [
      fileId,
      ...user.studyAccess.map((access) => access.studyId),
    ];

    // For sample admins, we need to handle the array parameters differently
    // First, let's modify the query parts to use a different approach
    const sampleAdminQueryParts = user.studyAccess
      .filter((access) => access.role === "SAMPLE_ADMIN")
      .map((access, idx) => {
        // For each sample ID, create a separate condition
        if (Array.isArray(access.sampleIds) && access.sampleIds.length > 0) {
          const sampleConditions = access.sampleIds.map(
            (sampleId, sampleIdx) => {
              const paramIndex = params.length + 1;
              params.push(sampleId.toString()); // Add the sample ID as a string parameter
              return `(df.sample_id::text = $${paramIndex})`;
            }
          );

          // Join all sample conditions with OR
          return `(df.study_id = $${
            user.studyAccess.indexOf(access) + 2
          } AND (df.sample_id IS NULL OR ${sampleConditions.join(" OR ")}))`;
        } else {
          // If no sample IDs, just check the study ID
          return `(df.study_id = $${user.studyAccess.indexOf(access) + 2})`;
        }
      });

    // Replace the sample admin query parts in the original query parts
    const updatedQueryParts = user.studyAccess.map((access, idx) => {
      if (access.role === "SAMPLE_ADMIN") {
        const sampleAdminIndex = user.studyAccess
          .filter((a) => a.role === "SAMPLE_ADMIN")
          .indexOf(access);
        return sampleAdminQueryParts[sampleAdminIndex];
      } else {
        return `(df.study_id = $${idx + 2})`;
      }
    });

    const updatedWhereClause = updatedQueryParts.join(" OR ");

    console.log("Updated where clause for file:", updatedWhereClause);
    console.log("Parameters for file:", params);

    // Modified query to ensure proper type casting
    const query = `
      SELECT *
      FROM fw_psy_dataset_file df
      WHERE df.dataset_file_id::text = $1
      AND (${updatedWhereClause})
    `;

    console.log("Dataset file query:", query);
    console.log("Query parameters:", params);

    const result = await pool.query(query, params);

    if (result.rows.length === 0) {
      return res
        .status(404)
        .json({ error: "Dataset file not found or access denied" });
    }

    const file = result.rows[0];
    const filePath = path.join(config.files.datasets.path, file.filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Dataset file not found on disk" });
    }

    // Get file stats to set content length
    const stats = await stat(filePath);
    console.log(`Serving file: ${filePath}, size: ${stats.size} bytes`);

    // Set appropriate headers for file download
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", stats.size);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${file.filename}"`
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
    console.error("Error fetching dataset file:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
