const express = require("express");
const router = express.Router();
const { Pool } = require("pg");
const config = require("../../config");
const { ROLES } = require("../../constants");

const pool = new Pool(config.db);

/* GET study status with configurable time period */
router.get("/", async (req, res) => {
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
          AND su.sample_id::text = ANY($${
            idx + 2 + req.user.studyAccess.length
          }::text[])
        ))`;
      }
      return `(u.study_id = ${param})`;
    });

    const accessClause =
      queryParts.length > 0 ? `WHERE ${queryParts.join(" OR ")}` : "";

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    // Prepare parameters with proper type casting for arrays
    const params = [
      cutoffDate.toISOString(),
      ...req.user.studyAccess.map((access) => access.studyId),
    ];

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
              return `(su.sample_id::text = $${paramIndex})`;
            }
          );

          // Join all sample conditions with OR
          return `(u.study_id = $${
            req.user.studyAccess.indexOf(access) + 2
          } AND EXISTS (
            SELECT 1 FROM fw_psy_sample_user su 
            WHERE su.user_id = u.user_id 
            AND (${sampleConditions.join(" OR ")})
          ))`;
        } else {
          // If no sample IDs, just check the study ID
          return `(u.study_id = $${req.user.studyAccess.indexOf(access) + 2})`;
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
        return `(u.study_id = $${idx + 2})`;
      }
    });

    const updatedAccessClause =
      updatedQueryParts.length > 0
        ? `WHERE ${updatedQueryParts.join(" OR ")}`
        : "";

    console.log("Updated access clause:", updatedAccessClause);
    console.log("Parameters:", params);

    try {
      // Build the basic metrics query - PostgreSQL 9.6 compatible
      const basicMetricsQuery = `
        WITH study_metrics AS (
          SELECT
            u.study_id,
            COUNT(DISTINCT u.user_id) as total_users,
            COUNT(DISTINCT CASE WHEN utl.submission_time >= $1 THEN u.user_id ELSE NULL END) as active_users,
            COUNT(DISTINCT ut.user_task_id) as assigned_tasks,
            COUNT(DISTINCT CASE WHEN ut.enabled = true THEN ut.user_task_id ELSE NULL END) as enabled_tasks,
            COUNT(utl.user_task_log_id) as total_submissions,
            COUNT(CASE WHEN utl.submission_time >= $1 THEN utl.user_task_log_id ELSE NULL END) as recent_submissions,
            ROUND(AVG(EXTRACT(EPOCH FROM (utl.submission_time - ut.assigned_time)))::numeric, 2) as avg_submission_lag_seconds,
            ROUND(AVG(EXTRACT(EPOCH FROM (utl.processing_time - utl.submission_time)))::numeric, 2) as avg_processing_time_seconds,
            MAX(utl.submission_time) as latest_submission,
            MIN(utl.submission_time) as earliest_submission,
            MAX(utl.processing_time) as latest_processing,
            COUNT(DISTINCT uti.user_task_instance_id) as total_instances_used,
            COUNT(DISTINCT CASE WHEN utl.submission_time >= $1 THEN uti.user_task_instance_id ELSE NULL END) as recent_instances_used
          FROM
            fw_psy_user u
          LEFT JOIN fw_psy_user_task ut ON u.user_id = ut.user_id
          LEFT JOIN fw_psy_user_task_log utl ON ut.user_task_id = utl.user_task_id
          LEFT JOIN fw_psy_user_task_instance uti ON utl.user_task_instance_id = uti.user_task_instance_id
          ${updatedAccessClause}
          GROUP BY u.study_id
        ),
        overall_metrics AS (
          SELECT
            SUM(total_users) as total_users,
            SUM(active_users) as active_users,
            SUM(assigned_tasks) as assigned_tasks,
            SUM(enabled_tasks) as enabled_tasks,
            SUM(total_submissions) as total_submissions,
            SUM(recent_submissions) as recent_submissions,
            ROUND(AVG(avg_submission_lag_seconds)::numeric, 2) as avg_submission_lag_seconds,
            ROUND(AVG(avg_processing_time_seconds)::numeric, 2) as avg_processing_time_seconds,
            SUM(total_instances_used) as total_instances_used,
            SUM(recent_instances_used) as recent_instances_used
          FROM study_metrics
        ),
        study_json AS (
          SELECT
            CASE 
              WHEN (SELECT COUNT(*) FROM study_metrics) = 0 THEN '[]'::json
              ELSE COALESCE(
                (SELECT json_agg(
                  json_build_object(
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
                  )
                ) FROM study_metrics),
                '[]'::json
              )
            END as by_study
        ),
        overall_json AS (
          SELECT
            json_build_object(
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
                'avg_processing_time_seconds', avg_processing_time_seconds
              ),
              'task_instances', json_build_object(
                'total_used', total_instances_used,
                'used_in_period', recent_instances_used
              )
            ) as overall
          FROM overall_metrics
        )
        SELECT
          json_build_object(
            'overall', (SELECT overall FROM overall_json),
            'by_study', (SELECT by_study FROM study_json)
          ) as stats
      `;

      // Execute the basic metrics query
      try {
        console.log(
          "Executing basic metrics query with params:",
          JSON.stringify(params)
        );
        const basicMetricsResult = await pool.query(basicMetricsQuery, params);
        console.log("Basic metrics query executed successfully");

        // Get the basic stats
        const stats = basicMetricsResult.rows[0].stats;

        // Log the stats object for debugging
        console.log("Stats object type:", typeof stats);
        console.log("Stats by_study type:", typeof stats.by_study);
        console.log("Stats by_study is array:", Array.isArray(stats.by_study));
        console.log("Stats by_study value:", JSON.stringify(stats.by_study));
      } catch (queryError) {
        console.error("Error executing basic metrics query:", queryError);
        console.error("SQL Query:", basicMetricsQuery);
        console.error("Params:", JSON.stringify(params));

        // Return a more detailed error response
        return res.status(500).json({
          success: false,
          error: "Database query error",
          details: queryError.message,
        });
      }

      // Add this check before iterating over stats.by_study
      if (!stats.by_study || !Array.isArray(stats.by_study)) {
        console.log(
          "Warning: stats.by_study is not an array:",
          JSON.stringify(stats)
        );
        stats.by_study = []; // Convert to empty array to prevent errors
      }

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
          const dateRange = dateRangeResult.rows[0];

          // Determine appropriate time aggregation based on date range
          let timeAggregation = "day";
          if (
            dateRange.date_range_days !== null &&
            dateRange.earliest_date !== null &&
            dateRange.latest_date !== null
          ) {
            const rangeDays = parseFloat(dateRange.date_range_days);
            if (rangeDays > 90) {
              timeAggregation = "month";
            } else if (rangeDays > 30) {
              timeAggregation = "week";
            }

            studyAggregationMap[studyId] = {
              timeAggregation,
              dateRangeDays: rangeDays,
              earliestDate: dateRange.earliest_date,
              latestDate: dateRange.latest_date,
            };

            // Get submissions by day/week/month for this study
            const submissionsQuery = `
              SELECT 
                DATE_TRUNC('${timeAggregation}', utl.submission_time)::date as aggregated_date,
                COUNT(*) as submission_count
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
      if (stats.by_study && Array.isArray(stats.by_study)) {
        stats.by_study.forEach((study) => {
          const studyId = study.study_id;

          // Ensure submissions_by_day is always an array
          if (
            !submissionsMap[studyId] ||
            !Array.isArray(submissionsMap[studyId])
          ) {
            console.log(
              `Warning: submissionsMap[${studyId}] is not an array, initializing as empty array`
            );
            submissionsMap[studyId] = [];
          }

          study.submissions_by_day = submissionsMap[studyId];

          // Add aggregation info to the study
          if (studyAggregationMap[studyId]) {
            study.time_aggregation =
              studyAggregationMap[studyId].timeAggregation;
            study.date_range_days = studyAggregationMap[studyId].dateRangeDays;
          } else {
            // Ensure aggregation info is always present
            study.time_aggregation = "day";
            study.date_range_days = 0;
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

      // Final validation before sending response
      if (!stats.by_study || !Array.isArray(stats.by_study)) {
        console.log(
          "Final validation: stats.by_study is not an array, setting to empty array"
        );
        stats.by_study = [];
      }

      // Ensure each study has the required properties
      stats.by_study.forEach((study, index) => {
        if (
          !study.submissions_by_day ||
          !Array.isArray(study.submissions_by_day)
        ) {
          console.log(
            `Final validation: study at index ${index} has invalid submissions_by_day, setting to empty array`
          );
          study.submissions_by_day = [];
        }
      });

      // Send the response
      res.json({
        success: true,
        data: {
          overall: stats.overall,
          by_study: stats.by_study,
          period_days: days,
          cutoff_date: cutoffDate.toISOString(),
          time_aggregation: overallAggregation,
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

module.exports = router;
