const express = require("express");
const router = express.Router();
const { Pool } = require("pg");
const config = require("../../config");

const pool = new Pool(config.db);

// Get participants for a study/sample with pagination and search
router.get("/", async (req, res) => {
  const {
    studyId,
    sampleId,
    page = "1",
    pageSize = "20",
    search = "",
    sortBy = "user_code",
    sortOrder = "asc",
  } = req.query;

  console.log("Raw query parameters:", {
    studyId,
    sampleId,
    page,
    pageSize,
    search,
    sortBy,
    sortOrder,
  });

  // Ensure page and pageSize are positive integers
  const pageNum = Math.max(1, parseInt(page));
  const pageSizeNum = Math.max(1, parseInt(pageSize));
  const offset = (pageNum - 1) * pageSizeNum;

  console.log("Parsed pagination values:", {
    pageNum,
    pageSizeNum,
    offset,
  });

  try {
    console.log("Building query with parameters:", {
      studyId,
      sampleId,
      search,
      sortBy,
      sortOrder,
      pageSizeNum,
      offset,
    });

    // Base conditions that apply to both count and data queries
    let baseConditions = `WHERE u.study_id = $1`;
    const queryParams = [studyId];
    let paramIndex = 2;

    // Add sample filter if provided
    if (sampleId) {
      baseConditions += ` AND EXISTS (
        SELECT 1 FROM fw_psy_sample_user su 
        WHERE su.user_id = u.user_id 
        AND su.sample_id::text = $${paramIndex}::text
      )`;
      // Ensure sampleId is properly formatted
      queryParams.push(sampleId);
      paramIndex++;
      console.log(`Added sample filter for sample ID: ${sampleId}`);
    }

    // Add search filter if provided
    if (search) {
      const searchPattern = `%${search}%`;
      baseConditions += ` AND (u.user_code ILIKE $${paramIndex} OR u.email_address ILIKE $${paramIndex})`;
      queryParams.push(searchPattern);
      paramIndex++;
    }

    // First get the metrics for each user
    let dataQuery = `
      WITH user_metrics AS (
        SELECT 
          u.user_id,
          u.user_code,
          u.email_address,
          COALESCE(MAX(utl.submission_time), NULL) as last_submission,
          COUNT(DISTINCT utl.task_log_id) as completed_tasks,
          COUNT(DISTINCT ut.task_id) as assigned_tasks,
          COALESCE(array_agg(DISTINCT utl.task_log_id) FILTER (WHERE utl.task_log_id IS NOT NULL), ARRAY[]::integer[]) as completed_task_ids
        FROM fw_psy_user u
        LEFT JOIN fw_psy_user_task ut ON u.user_id = ut.user_id
        LEFT JOIN fw_psy_user_task_log utl ON ut.user_task_id = utl.user_task_id
        ${baseConditions}
        GROUP BY u.user_id, u.user_code, u.email_address
        ORDER BY ${sortBy} ${sortOrder === "desc" ? "DESC" : "ASC"}
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      )
      SELECT * FROM user_metrics
    `;

    // Count query for total rows
    let countQuery = `
      SELECT COUNT(DISTINCT u.user_id)
      FROM fw_psy_user u
      ${baseConditions}
    `;

    // Add pagination parameters
    queryParams.push(pageSizeNum, offset);

    console.log("Final query parameters:", queryParams);

    // Execute queries
    console.log("Query execution details:", {
      countQuery,
      dataQuery,
      queryParams,
      parameterTypes: queryParams.map((p) => `${p} (${typeof p})`),
      page: { raw: page, parsed: pageNum, type: typeof page },
      pageSize: { raw: pageSize, parsed: pageSizeNum, type: typeof pageSize },
      offset: {
        value: offset,
        calculation: `(${pageNum} - 1) * ${pageSizeNum}`,
        components: {
          pageNum: { value: pageNum, type: typeof pageNum },
          pageSizeNum: { value: pageSizeNum, type: typeof pageSizeNum },
        },
      },
    });

    // Double check offset is not negative
    if (offset < 0) {
      console.error("Negative offset detected:", {
        pageNum,
        pageSizeNum,
        offset,
        calculation: `(${pageNum} - 1) * ${pageSizeNum}`,
      });
      return res.status(400).json({
        success: false,
        error: "Invalid pagination parameters",
        details: "Calculated offset is negative",
      });
    }
    const countResult = await pool.query(countQuery, queryParams.slice(0, -2));
    const dataResult = await pool.query(dataQuery, queryParams);

    const totalRows = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalRows / pageSizeNum);

    res.json({
      success: true,
      data: dataResult.rows,
      pagination: {
        page: pageNum,
        pageSize: pageSizeNum,
        totalRows,
        totalPages,
      },
    });
  } catch (error) {
    console.error("Error fetching participants:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch participants",
      details: error.message,
    });
  }
});

module.exports = router;
