const express = require("express");
const router = express.Router();
const { Pool } = require("pg");
const config = require("../config");
const { validateDataAccessToken, User } = require("../middleware/auth");
const { ROLES } = require("../constants");
const path = require("path");
const fs = require("fs");
const { promisify } = require("util");
const stat = promisify(fs.stat);
const readdir = promisify(fs.readdir);
const jwt = require("jsonwebtoken");

const pool = new Pool(config.db);

// Apply auth middleware to all routes
router.use(validateDataAccessToken);

/* GET users listing with permission check and study/sample filter */
router.get("/users", async (req, res) => {
  try {
    if (!req.user.permissions.includes("READ_USERS")) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    // Build query parts for each study based on access level
    const queryParts = req.user.studyAccess.map((access, idx) => {
      const param = `$${idx + 1}`;
      if (ROLES[access.role] === ROLES.STUDY_ADMIN) {
        return `(ut.study_id = ${param})`;
      } else if (access.role === "SAMPLE_ADMIN") {
        // For sample admins, check against fw_psy_sample_user table
        return `(ut.study_id = ${param} AND EXISTS (
          SELECT 1 FROM fw_psy_sample_user su 
          WHERE su.user_id = u.user_id 
          AND su.study_id = ut.study_id 
          AND su.sample_id = ANY($${idx + 1 + req.user.studyAccess.length})
        ))`;
      }
      return `(ut.study_id = ${param})`;
    });

    // Construct the complete query
    const query = `
      SELECT DISTINCT u.* 
      FROM fw_psy_user u
      INNER JOIN fw_psy_user_task ut ON u.user_id = ut.user_id
      WHERE ${queryParts.join(" OR ")}
      ORDER BY u.user_id ASC
    `;

    // Build parameters array
    const params = [
      ...req.user.studyAccess.map((access) => access.studyId),
      ...req.user.studyAccess
        .filter((access) => access.role === "SAMPLE_ADMIN")
        .map((access) => access.sampleIds),
    ];

    const results = await pool.query(query, params);
    res.status(200).json(results.rows);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* GET task logs with permission check and study/sample filter */
router.get("/tasklogs", async (req, res) => {
  try {
    if (!req.user.permissions.includes("READ_LOGS")) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const queryParts = req.user.studyAccess.map((access, idx) => {
      const param = `$${idx + 1}`;
      if (ROLES[access.role] === ROLES.STUDY_ADMIN) {
        return `(ut.study_id = ${param})`;
      } else if (access.role === "SAMPLE_ADMIN") {
        // For sample admins, check against fw_psy_sample_user table
        return `(ut.study_id = ${param} AND EXISTS (
          SELECT 1 FROM fw_psy_sample_user su 
          WHERE su.user_id = ut.user_id 
          AND su.study_id = ut.study_id 
          AND su.sample_id = ANY($${idx + 1 + req.user.studyAccess.length})
        ))`;
      }
      return `(ut.study_id = ${param})`;
    });

    const query = `
      SELECT l.* 
      FROM fw_psy_user_task_log l
      INNER JOIN fw_psy_user_task ut ON l.user_task_id = ut.user_task_id
      WHERE ${queryParts.join(" OR ")}
      ORDER BY l.user_task_id ASC
    `;

    const params = [
      ...req.user.studyAccess.map((access) => access.studyId),
      ...req.user.studyAccess
        .filter((access) => access.role === "SAMPLE_ADMIN")
        .map((access) => access.sampleIds),
    ];

    const results = await pool.query(query, params);
    res.status(200).json(results.rows);
  } catch (error) {
    console.error("Error fetching task logs:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* GET user tasks with permission check and study/sample filter */
router.get("/userTask/:userId", async (req, res) => {
  try {
    if (!req.user.permissions.includes("READ_TASKS")) {
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({ error: "Missing user ID" });
    }

    const queryParts = req.user.studyAccess.map((access, idx) => {
      const param = `$${idx + 2}`; // +2 because $1 is userId
      if (ROLES[access.role] === ROLES.STUDY_ADMIN) {
        return `(t.study_id = ${param})`;
      } else if (access.role === "SAMPLE_ADMIN") {
        // For sample admins, check against fw_psy_sample_user table
        return `(t.study_id = ${param} AND EXISTS (
          SELECT 1 FROM fw_psy_sample_user su 
          WHERE su.user_id = t.user_id 
          AND su.study_id = t.study_id 
          AND su.sample_id = ANY($${idx + 2 + req.user.studyAccess.length})
        ))`;
      }
      return `(t.study_id = ${param})`;
    });

    const query = `
      SELECT t.* 
      FROM fw_psy_user_task t
      WHERE t.user_id = $1 
      AND (${queryParts.join(" OR ")})
      ORDER BY t.user_id ASC
    `;

    const params = [
      userId,
      ...req.user.studyAccess.map((access) => access.studyId),
      ...req.user.studyAccess
        .filter((access) => access.role === "SAMPLE_ADMIN")
        .map((access) => access.sampleIds),
    ];

    const results = await pool.query(query, params);
    res.status(200).json(results.rows);
  } catch (error) {
    console.error("Error fetching user tasks:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* GET study status with configurable time period */
router.get("/status", async (req, res) => {
  try {
    // Debug logging for permissions
    console.log("==== STATUS ENDPOINT DEBUG ====");
    console.log("User ID:", req.user.id);
    console.log("User Permissions:", req.user.permissions);
    console.log(
      "User Study Access:",
      JSON.stringify(req.user.studyAccess, null, 2)
    );
    console.log("Is Super Admin:", req.user.isSuperAdmin);
    console.log("Accessible Studies:", req.user.getAccessibleStudies());
    console.log("==============================");

    // Default to 7 days if no period specified
    const days = parseInt(req.query.days) || 7;

    // Validate days parameter
    if (days <= 0 || days > 365) {
      return res.status(400).json({
        error: "Days parameter must be between 1 and 365",
      });
    }

    // Build query parts for study access
    const accessibleStudies = req.user.getAccessibleStudies();
    console.log("Filtering status data for studies:", accessibleStudies);

    // If no studies are accessible, return empty data
    if (accessibleStudies.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          overall: {
            users: { total: 0, active_in_period: 0 },
            tasks: { assigned: 0, enabled: 0 },
            activity: {
              total_submissions: 0,
              submissions_in_period: 0,
              avg_submission_lag_seconds: 0,
              avg_processing_time_seconds: 0,
            },
            task_instances: { total_used: 0, used_in_period: 0 },
          },
          by_study: [],
          period_days: days,
          cutoff_date: new Date(Date.now() - days * 86400000).toISOString(),
        },
      });
    }

    const queryParts = req.user.studyAccess.map((access, idx) => {
      const param = `$${idx + 2}`; // $1 is the date
      if (ROLES[access.role] === ROLES.STUDY_ADMIN) {
        return `(u.study_id = ${param})`;
      } else if (access.role === "SAMPLE_ADMIN") {
        return `(u.study_id = ${param} AND EXISTS (
          SELECT 1 FROM fw_psy_sample_user su 
          WHERE su.user_id = u.user_id 
          AND su.study_id = u.study_id 
          AND su.sample_id = ANY($${idx + 2 + req.user.studyAccess.length})
        ))`;
      }
      return `(u.study_id = ${param})`;
    });

    const accessClause =
      queryParts.length > 0 ? `WHERE ${queryParts.join(" OR ")}` : "";

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const params = [
      cutoffDate.toISOString(),
      ...req.user.studyAccess.map((access) => access.studyId),
      ...req.user.studyAccess
        .filter((access) => access.role === "SAMPLE_ADMIN")
        .map((access) => access.sampleIds),
    ];

    try {
      // First, get the basic metrics for each study
      const basicMetricsQuery = `
        WITH study_metrics AS (
          SELECT 
            u.study_id,
            -- Basic user counts
            COUNT(DISTINCT u.user_id) as total_users,
            COUNT(DISTINCT CASE 
              WHEN utl.submission_time >= $1 THEN u.user_id 
            END) as active_users,
            
            -- Task assignments
            COUNT(DISTINCT ut.task_id) as assigned_tasks,
            COUNT(DISTINCT CASE 
              WHEN ut.enabled = true THEN ut.task_id 
            END) as enabled_tasks,
            
            -- Submission counts
            COUNT(DISTINCT utl.task_log_id) as total_submissions,
            COUNT(DISTINCT CASE 
              WHEN utl.submission_time >= $1 THEN utl.task_log_id 
            END) as recent_submissions,
            
            -- Task instances
            COUNT(DISTINCT utl.task_instance_id) as total_instances_used,
            COUNT(DISTINCT CASE 
              WHEN utl.submission_time >= $1 THEN utl.task_instance_id 
            END) as recent_instances_used,
            
            -- Timing metrics (in seconds)
            ROUND(AVG(
              CASE 
                WHEN utl.submission_time >= $1 
                THEN EXTRACT(EPOCH FROM (utl.submission_time - utl.user_completion_time))
              END
            )::numeric, 2) as avg_submission_lag_seconds,
            
            ROUND(AVG(
              CASE 
                WHEN utl.submission_time >= $1 AND utl.processed_time IS NOT NULL
                THEN EXTRACT(EPOCH FROM (utl.processed_time - utl.submission_time))
              END
            )::numeric, 2) as avg_processing_time_seconds,
            
            -- Activity timestamps
            MAX(utl.submission_time) as latest_submission,
            MIN(utl.submission_time) as earliest_submission,
            MAX(utl.processed_time) as latest_processing
          FROM fw_psy_user u
          LEFT JOIN fw_psy_user_task ut ON u.user_id = ut.user_id
          LEFT JOIN fw_psy_user_task_log utl ON ut.user_task_id = utl.user_task_id
          ${accessClause}
          GROUP BY u.study_id
        )
        SELECT 
          json_build_object(
            'overall', json_build_object(
              'users', json_build_object(
                'total', SUM(total_users),
                'active_in_period', SUM(active_users)
              ),
              'tasks', json_build_object(
                'assigned', SUM(assigned_tasks),
                'enabled', SUM(enabled_tasks)
              ),
              'activity', json_build_object(
                'total_submissions', SUM(total_submissions),
                'submissions_in_period', SUM(recent_submissions),
                'avg_submission_lag_seconds', ROUND(AVG(avg_submission_lag_seconds)::numeric, 2),
                'avg_processing_time_seconds', ROUND(AVG(avg_processing_time_seconds)::numeric, 2)
              ),
              'task_instances', json_build_object(
                'total_used', SUM(total_instances_used),
                'used_in_period', SUM(recent_instances_used)
              )
            ),
            'by_study', json_agg(json_build_object(
              'study_id', study_id,
              'users', json_build_object(
                'total', total_users,
                'active_in_period', active_users
              ),
              'tasks', json_build_object(
                'assigned', assigned_tasks,
                'enabled', enabled_tasks
              ),
              'activity', json_build_object(
                'total_submissions', total_submissions,
                'submissions_in_period', recent_submissions,
                'avg_submission_lag_seconds', avg_submission_lag_seconds,
                'avg_processing_time_seconds', avg_processing_time_seconds,
                'latest_submission', latest_submission,
                'earliest_submission', earliest_submission,
                'latest_processing', latest_processing
              ),
              'task_instances', json_build_object(
                'total_used', total_instances_used,
                'used_in_period', recent_instances_used
              )
            ))
          ) as stats
        FROM study_metrics
      `;

      // Execute the basic metrics query
      const basicMetricsResult = await pool.query(basicMetricsQuery, params);
      console.log("Basic metrics query executed successfully");

      // Get the basic stats
      const stats = basicMetricsResult.rows[0].stats;

      // Now determine date ranges and appropriate aggregation for each study
      const studyAggregationMap = {};
      const submissionsMap = {};

      // Process each study individually
      for (const study of stats.by_study) {
        const studyId = study.study_id;

        try {
          // Get date range for this study
          const dateRangeQuery = `
            SELECT 
              MIN(utl.submission_time) as earliest_date,
              MAX(utl.submission_time) as latest_date,
              EXTRACT(DAY FROM (MAX(utl.submission_time) - MIN(utl.submission_time))) as date_range_days
            FROM fw_psy_user_task_log utl
            JOIN fw_psy_user_task ut ON utl.user_task_id = ut.user_task_id
            JOIN fw_psy_user u ON ut.user_id = u.user_id
            WHERE u.study_id = $1
          `;

          const dateRangeResult = await pool.query(dateRangeQuery, [studyId]);

          if (dateRangeResult.rows.length > 0) {
            const row = dateRangeResult.rows[0];
            let timeAggregation = "day";
            const dateRangeDays = parseFloat(row.date_range_days || 0);

            // Determine appropriate aggregation based on date range
            if (dateRangeDays > 365) {
              timeAggregation = "month";
            } else if (dateRangeDays > 60) {
              timeAggregation = "week";
            }

            studyAggregationMap[studyId] = {
              timeAggregation,
              dateRangeDays,
              earliestDate: row.earliest_date,
              latestDate: row.latest_date,
            };

            console.log(
              `Study ${studyId} has date range of ${dateRangeDays} days, using ${timeAggregation} aggregation`
            );

            // Get submissions data with appropriate aggregation
            const submissionsQuery = `
              SELECT 
                DATE_TRUNC('${timeAggregation}', utl.submission_time)::date as aggregated_date,
                COUNT(DISTINCT utl.task_log_id) as submission_count
              FROM fw_psy_user_task_log utl
              JOIN fw_psy_user_task ut ON utl.user_task_id = ut.user_task_id
              JOIN fw_psy_user u ON ut.user_id = u.user_id
              WHERE u.study_id = $1
              GROUP BY DATE_TRUNC('${timeAggregation}', utl.submission_time)::date
              ORDER BY aggregated_date
            `;

            const submissionsResult = await pool.query(submissionsQuery, [
              studyId,
            ]);

            // Format the submissions data
            submissionsMap[studyId] = submissionsResult.rows.map((row) => ({
              date: row.aggregated_date,
              count: parseInt(row.submission_count),
              aggregation: timeAggregation,
            }));

            console.log(
              `Study ${studyId} submissions data:`,
              JSON.stringify(submissionsMap[studyId])
            );
          } else {
            studyAggregationMap[studyId] = {
              timeAggregation: "day",
              dateRangeDays: 0,
              earliestDate: null,
              latestDate: null,
            };
            submissionsMap[studyId] = [];
          }
        } catch (studyError) {
          console.error(`Error processing study ${studyId}:`, studyError);
          studyAggregationMap[studyId] = {
            timeAggregation: "day",
            dateRangeDays: 0,
            earliestDate: null,
            latestDate: null,
          };
          submissionsMap[studyId] = [];
        }
      }

      // Add submissions data and aggregation info to each study
      if (stats.by_study) {
        stats.by_study.forEach((study) => {
          const studyId = study.study_id;
          study.submissions_by_day = submissionsMap[studyId] || [];

          // Add aggregation info to the study
          if (studyAggregationMap[studyId]) {
            study.time_aggregation =
              studyAggregationMap[studyId].timeAggregation;
            study.date_range_days = studyAggregationMap[studyId].dateRangeDays;
          }
        });
      }

      // Determine overall aggregation (use the most common one)
      const aggregationCounts = Object.values(studyAggregationMap).reduce(
        (counts, { timeAggregation }) => {
          counts[timeAggregation] = (counts[timeAggregation] || 0) + 1;
          return counts;
        },
        {}
      );

      const overallAggregation =
        Object.entries(aggregationCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ||
        "day";

      res.status(200).json({
        success: true,
        data: {
          ...stats,
          period_days: days,
          cutoff_date: cutoffDate.toISOString(),
          time_aggregation: overallAggregation,
          study_aggregations: studyAggregationMap,
        },
      });
    } catch (error) {
      console.error("Error fetching status:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  } catch (error) {
    console.error("Error fetching status:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

/* GET dataset files listing with metadata */
router.get("/datasets", async (req, res) => {
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
          (df.sample_id IS NULL OR df.sample_id = ANY($${
            idx + 1 + req.user.studyAccess.length
          })))`;
      }
      return `(df.study_id = ${param})`;
    });

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
      WHERE ${queryParts.join(" OR ")}
      ORDER BY df.updated_time DESC
    `;

    const params = [
      ...req.user.studyAccess.map((access) => access.studyId),
      ...req.user.studyAccess
        .filter((access) => access.role === "SAMPLE_ADMIN")
        .map((access) => access.sampleIds),
    ];

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
router.get("/datasets/:fileId", async (req, res) => {
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
          (df.sample_id IS NULL OR df.sample_id = ANY($${
            idx + 2 + user.studyAccess.length
          })))`;
      }
      return `(df.study_id = ${param})`;
    });

    // Modified query to ensure proper type casting
    const query = `
      SELECT *
      FROM fw_psy_dataset_file df
      WHERE df.dataset_file_id::text = $1
      AND (${queryParts.join(" OR ")})
    `;

    const params = [
      fileId,
      ...user.studyAccess.map((access) => access.studyId),
      ...user.studyAccess
        .filter((access) => access.role === "SAMPLE_ADMIN")
        .map((access) => access.sampleIds),
    ];

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

    // Don't set Transfer-Encoding when Content-Length is present
    // res.setHeader("Transfer-Encoding", "identity");

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

/* GET study files listing */
router.get("/studies/:studyId/files/:role?", async (req, res) => {
  try {
    const { studyId, role } = req.params;

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
router.get("/studies/:studyId/files/:role/:filepath(*)", async (req, res) => {
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

/**
 * Get all studies and their samples
 * This endpoint is accessible to all authenticated users
 */
router.get("/studies", validateDataAccessToken, async (req, res) => {
  try {
    console.log("Fetching studies...");
    const query = `
      SELECT * FROM fw_psy_study 
      LEFT JOIN fw_psy_sample USING (study_id)
    `;

    const result = await pool.query(query);
    console.log("Query result:", JSON.stringify(result.rows, null, 2));

    // Group samples by study_id in JavaScript
    const studiesMap = new Map();

    result.rows.forEach((row) => {
      console.log("Processing row:", JSON.stringify(row, null, 2));
      if (!studiesMap.has(row.study_id)) {
        // Create new study entry with all study fields
        const study = {
          study_id: row.study_id,
          terms: row.terms,
          samples: [],
        };
        console.log("Created new study:", JSON.stringify(study, null, 2));
        studiesMap.set(row.study_id, study);
      }

      // Add sample if it exists (if sample_id is not null)
      if (row.sample_id) {
        const sample = {
          sample_id: row.sample_id,
          sample_code: row.sample_code,
          sample_name: row.sample_name,
        };
        console.log(
          "Adding sample to study:",
          row.study_id,
          JSON.stringify(sample, null, 2)
        );
        studiesMap.get(row.study_id).samples.push(sample);
      }
    });

    const response = {
      success: true,
      data: Array.from(studiesMap.values()),
    };

    console.log("Final response:", JSON.stringify(response, null, 2));
    res.json(response);
  } catch (error) {
    console.error("Error fetching studies and samples:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch studies and samples",
    });
  }
});

module.exports = router;
