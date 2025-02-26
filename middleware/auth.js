const jwt = require("jsonwebtoken");
const config = require("../config");
const { ROLES } = require("../constants");

/**
 * Study access roles and their hierarchy
 */
const ROLES_CONST = {
  STUDY_ADMIN: 3,
  SAMPLE_ADMIN: 2,
  VIEWER: 1,
};

/**
 * Default permissions for each role
 */
const ROLE_PERMISSIONS = {
  STUDY_ADMIN: [
    "READ_USERS",
    "READ_LOGS",
    "READ_TASKS",
    "READ_DATASETS",
    "WRITE_USERS",
    "WRITE_TASKS",
    "ADMIN",
  ],
  SAMPLE_ADMIN: [
    "READ_USERS",
    "READ_LOGS",
    "READ_TASKS",
    "READ_DATASETS",
    "WRITE_USERS",
  ],
  VIEWER: ["READ_DATASETS"],
};

// User class to handle permissions and study access
class User {
  constructor(id, studyAccess = []) {
    this.id = id;
    this.studyAccess = studyAccess;
  }

  // Derive permissions from study roles
  get permissions() {
    const permissionSet = new Set();

    // Add permissions based on study roles
    this.studyAccess.forEach((access) => {
      const rolePermissions = ROLE_PERMISSIONS[access.role] || [];
      rolePermissions.forEach((perm) => permissionSet.add(perm));
    });

    return Array.from(permissionSet);
  }

  // Check if user has a specific permission
  hasPermission(permission) {
    return this.permissions.includes(permission);
  }

  // Get list of studies the user has access to
  getAccessibleStudies() {
    // Return unique study IDs from study access
    return [...new Set(this.studyAccess.map((access) => access.studyId))];
  }

  // Check if user has access to a specific study
  hasStudyAccess(studyId, minRole = "VIEWER") {
    const access = this.studyAccess.find((a) => a.studyId === studyId);
    return access && ROLES[access.role] >= ROLES[minRole];
  }

  // Check if user has a specific role for a study
  hasStudyRole(studyId, role) {
    return this.studyAccess.some(
      (access) => access.studyId === studyId && access.role === role
    );
  }

  // Check if user has access to a specific sample in a study
  hasSampleAccess(studyId, sampleId) {
    const studyAccess = this.studyAccess.find(
      (access) => access.studyId === studyId
    );

    if (!studyAccess) return false;

    // Study admins have access to all samples
    if (studyAccess.role === "STUDY_ADMIN") return true;

    // Sample admins have access to specific samples
    if (studyAccess.role === "SAMPLE_ADMIN") {
      // Handle both array and JSON string formats for sampleIds
      let sampleIds = studyAccess.sampleIds;

      // If sampleIds is a string (from JSON), parse it
      if (typeof sampleIds === "string") {
        try {
          sampleIds = JSON.parse(sampleIds);
        } catch (e) {
          console.error("Error parsing sampleIds:", e);
          return false;
        }
      }

      return Array.isArray(sampleIds) && sampleIds.includes(sampleId);
    }

    return false;
  }
}

/**
 * Middleware to validate data access tokens from Azure Functions
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
const validateDataAccessToken = (req, res, next) => {
  console.log("==== TOKEN VALIDATION DEBUG ====");
  console.log(
    "Authorization header:",
    req.headers.authorization ? "Present" : "Missing"
  );

  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    console.log("No token provided");
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    console.log("JWT decoded successfully:", {
      userId: decoded.userId,
      studyAccessCount: decoded.studyAccess?.length || 0,
    });

    // Validate required claims
    if (!decoded.userId || !decoded.studyAccess) {
      console.log("Invalid token claims:", {
        hasUserId: !!decoded.userId,
        hasStudyAccess: !!decoded.studyAccess,
      });
      return res.status(403).json({ error: "Invalid token claims" });
    }

    // Validate studyAccess structure
    if (
      !Array.isArray(decoded.studyAccess) ||
      !decoded.studyAccess.every(
        (access) =>
          access.studyId &&
          access.role &&
          ROLES[access.role] &&
          (access.role !== "SAMPLE_ADMIN" || Array.isArray(access.sampleIds))
      )
    ) {
      console.log("Invalid study access claims");
      return res.status(403).json({ error: "Invalid study access claims" });
    }

    // Create user object with study access
    const user = new User(decoded.userId, decoded.studyAccess);

    // Add user to request
    req.user = {
      id: user.id,
      studyAccess: user.studyAccess,
      permissions: user.permissions,
      region: decoded.region,
    };

    // Helper functions for permission checking
    req.user.hasPermission = (permission) => {
      return user.hasPermission(permission);
    };

    req.user.hasStudyAccess = (studyId, minRole = "VIEWER") => {
      return user.hasStudyAccess(studyId, minRole);
    };

    req.user.hasSampleAccess = (studyId, sampleId) => {
      return user.hasSampleAccess(studyId, sampleId);
    };

    req.user.getAccessibleStudies = (minRole = "VIEWER") => {
      return user.studyAccess
        .filter((access) => ROLES[access.role] >= ROLES[minRole])
        .map((access) => access.studyId);
    };

    req.user.getAccessibleSamples = (studyId) => {
      const access = user.studyAccess.find((a) => a.studyId === studyId);
      if (!access) return [];
      if (ROLES[access.role] === ROLES.STUDY_ADMIN) return ["*"]; // Study admins can access all samples
      return access.sampleIds || [];
    };

    // If studyId is provided in request params, validate access
    const studyId = req.params.studyId;
    if (studyId && !req.user.hasStudyAccess(studyId)) {
      console.log(
        `User ${req.user.id} does not have access to study ${studyId}`
      );
      return res.status(403).json({ error: "Unauthorized study access" });
    }

    console.log("User authenticated successfully:", {
      id: req.user.id,
      permissions: req.user.permissions,
      accessibleStudies: req.user.getAccessibleStudies(),
    });
    console.log("==============================");

    next();
  } catch (error) {
    console.error("JWT verification error:", error);
    return res.status(403).json({ error: "Invalid token" });
  }
};

// Middleware to authenticate requests
const authenticateUser = (req, res, next) => {
  console.log("==== AUTH MIDDLEWARE DEBUG ====");
  console.log("Headers:", req.headers);

  try {
    // Get user information from headers (passed by Azure Function)
    const userId = req.headers["x-user-id"];
    const userStudyAccess = JSON.parse(
      req.headers["x-user-study-access"] || "[]"
    );

    console.log("Parsed User ID:", userId);
    console.log("Parsed Study Access:", userStudyAccess);

    if (!userId) {
      console.log("No user ID found in request");
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Create user object
    const user = new User(userId, userStudyAccess);
    req.user = {
      id: user.id,
      studyAccess: user.studyAccess,
      permissions: user.permissions,
    };

    // Add helper methods
    req.user.hasPermission = (permission) => {
      return user.hasPermission(permission);
    };

    req.user.hasStudyAccess = (studyId, minRole = "VIEWER") => {
      return user.hasStudyAccess(studyId, minRole);
    };

    req.user.hasSampleAccess = (studyId, sampleId) => {
      return user.hasSampleAccess(studyId, sampleId);
    };

    req.user.getAccessibleStudies = (minRole = "VIEWER") => {
      return user.studyAccess
        .filter((access) => ROLES[access.role] >= ROLES[minRole])
        .map((access) => access.studyId);
    };

    req.user.getAccessibleSamples = (studyId) => {
      const access = user.studyAccess.find((a) => a.studyId === studyId);
      if (!access) return [];
      if (ROLES[access.role] === ROLES.STUDY_ADMIN) return ["*"]; // Study admins can access all samples
      return access.sampleIds || [];
    };

    console.log("User object created:", {
      id: req.user.id,
      permissions: req.user.permissions,
      studyAccess: req.user.studyAccess,
      accessibleStudies: req.user.getAccessibleStudies(),
    });
    console.log("==============================");

    next();
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(401).json({ error: "Authentication failed" });
  }
};

module.exports = {
  validateDataAccessToken,
  authenticateUser,
  User,
  ROLES_CONST,
};
