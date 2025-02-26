// Load dotenv in development, PM2 handles env vars in production
if (process.env.NODE_ENV !== "production") {
  require("dotenv").config();
}

module.exports = {
  db: {
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: parseInt(process.env.DB_PORT || "5432"),
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: "1h",
  },
  server: {
    port: parseInt(process.env.PORT || "3000"),
  },
  files: {
    datasets: {
      path: process.env.DATASET_FILES_PATH || "/var/psytools/datasets/",
    },
    study: {
      path: process.env.STUDY_FILES_PATH || "/var/psytools/study-files/",
      roles: ["ADMIN", "RESEARCHER", "CLINICIAN"], // Define allowed role folders
    },
  },
};
