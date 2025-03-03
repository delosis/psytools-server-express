module.exports = {
  apps: [
    {
      name: "psytools-express",
      script: "./bin/www",
      env_production: {
        NODE_ENV: "production",
        DB_USER: "your_db_user",
        DB_HOST: "your_db_host",
        DB_NAME: "your_db_name",
        DB_PASSWORD: "your_db_password",
        DB_PORT: 5432,
        JWT_SECRET: "your_jwt_secret",
        PORT: 3000,
        DATASET_FILES_PATH: "/var/psytools/datasets",
        STUDY_FILES_PATH: "/var/psytools/study-files",
        ALLOWED_ORIGINS: "https://your-function-app.azurewebsites.net",
      },
      // Optional performance tweaks
      exec_mode: "cluster",
      instances: "max", // or a number like 2
      max_memory_restart: "1G",
      // Logging configuration
      error_file: "/var/log/psytools-express/error.log",
      out_file: "/var/log/psytools-express/out.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      // User configuration
      user: "psytools",
    },
  ],
};
