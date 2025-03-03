const express = require("express");
const router = express.Router();
const { validateDataAccessToken } = require("../../middleware/auth");

// Import route modules
const participantsRouter = require("./participants");
const usersRouter = require("./users");
const tasklogsRouter = require("./tasklogs");
const tasksRouter = require("./tasks");
const statusRouter = require("./status");
const datasetsRouter = require("./datasets");
const studiesRouter = require("./studies");
const filesRouter = require("./files");

// Apply auth middleware to all routes
router.use(validateDataAccessToken);

// Mount routes
router.use("/participants", participantsRouter);
router.use("/users", usersRouter);
router.use("/tasklogs", tasklogsRouter);
router.use("/userTask", tasksRouter);
router.use("/status", statusRouter);
router.use("/datasets", datasetsRouter);
router.use("/studies", studiesRouter);
router.use("/studies/:studyId/files", filesRouter);

module.exports = router;
