const express = require("express");
const router = express.Router();
const { Pool } = require("pg");
const config = require("../../config");

const pool = new Pool(config.db);

/**
 * Get all studies and their samples
 * This endpoint is accessible to all authenticated users
 */
router.get("/", async (req, res) => {
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
