const express = require("express");
const router = express.Router();
const { Pool } = require("pg");
const config = require("../../config");
const { ROLES } = require("../../constants");

const pool = new Pool(config.db);

/* GET user tasks with permission check and study/sample filter */
router.get("/:userId", async (req, res) => {
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
        return `(u.study_id = ${param})`;
      } else if (access.role === "SAMPLE_ADMIN") {
        // For sample admins, check against fw_psy_sample_user table
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

    const query = `
      SELECT ut.* 
      FROM fw_psy_user_task ut
      INNER JOIN fw_psy_user u ON ut.user_id = u.user_id
      WHERE ut.user_id = $1 
      AND (${queryParts.join(" OR ")})
      ORDER BY ut.user_id ASC
    `;

    // Prepare parameters with proper type casting for arrays
    const params = [
      userId,
      ...req.user.studyAccess.map((access) => access.studyId),
    ];

    // Add sample IDs arrays with explicit type casting
    req.user.studyAccess
      .filter((access) => access.role === "SAMPLE_ADMIN")
      .forEach((access) => {
        // Ensure sampleIds is an array and cast it to a PostgreSQL array
        const sampleIdsArray = Array.isArray(access.sampleIds)
          ? access.sampleIds
          : [];
        params.push(sampleIdsArray);
      });

    console.log("Tasks parameters:", params);

    const results = await pool.query(query, params);
    res.status(200).json(results.rows);
  } catch (error) {
    console.error("Error fetching user tasks:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
