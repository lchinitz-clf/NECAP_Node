/**
 * Workspace management.
 *
 * A "workspace" is just a directory: workspaces/<id>/, containing that
 * workspace's own store.json (and, once document upload exists,
 * workspaces/<id>/uploads/ holding the actual files). This is what
 * lets you keep a Massachusetts document set and a Vermont document
 * set fully separate — separate stores means a query against one
 * workspace can never accidentally retrieve chunks from the other,
 * and you can see exactly what's in each one just by looking at its
 * folder, same philosophy as store.json being a plain file you can
 * open yourself.
 *
 * IMPORTANT — this is also the one place path safety has to be
 * airtight. workspaceId comes straight from request bodies, i.e. from
 * whoever is calling this server. Right now that's just you, on your
 * own machine, but this whole feature was designed with "this will
 * eventually run somewhere on the internet, for multiple people" in
 * mind — so workspaceId is validated against a strict allowlist
 * (letters, numbers, hyphens, underscores only) before it ever touches
 * the filesystem. That rules out "../../etc" or an absolute path
 * sneaking in and reading/writing outside workspaces/ entirely.
 */

const fs = require('fs');
const path = require('path');

const WORKSPACES_ROOT = path.join(__dirname, '..', 'workspaces');

const WORKSPACE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** @returns {boolean} */
function isValidWorkspaceId(id) {
  return typeof id === 'string' && WORKSPACE_ID_PATTERN.test(id);
}

/**
 * Resolves (but does not create) a workspace's directory path. Throws
 * if workspaceId fails validation — callers should validate with
 * isValidWorkspaceId() first to turn that into a clean 400 response
 * instead of a 500.
 * @param {string} workspaceId
 * @returns {string}
 */
function workspaceDir(workspaceId) {
  if (!isValidWorkspaceId(workspaceId)) {
    throw new Error(
      `Invalid workspace id "${workspaceId}". Use only letters, numbers, hyphens, and underscores (1-64 characters).`
    );
  }
  return path.join(WORKSPACES_ROOT, workspaceId);
}

/** @param {string} workspaceId @returns {string} */
function storePath(workspaceId) {
  return path.join(workspaceDir(workspaceId), 'store.json');
}

/** @param {string} workspaceId @returns {string} */
function uploadsDir(workspaceId) {
  return path.join(workspaceDir(workspaceId), 'uploads');
}

/**
 * Creates workspaces/<id>/uploads/ (and everything above it) if
 * missing, and returns its path. This is where uploaded PDFs actually
 * land on disk before being extracted/chunked/embedded.
 * @param {string} workspaceId
 * @returns {string}
 */
function ensureUploadsDir(workspaceId) {
  const dir = uploadsDir(workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Creates the workspace's directory (and workspaces/ itself) if it
 * doesn't already exist. Safe to call every time — this is what makes
 * "just start typing a new workspace name and embed into it" work
 * without a separate explicit "create workspace" step.
 * @param {string} workspaceId
 * @returns {string} the directory path
 */
function ensureWorkspaceDir(workspaceId) {
  const dir = workspaceDir(workspaceId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Lists existing workspace ids, for populating a UI picker. A
 * workspace "exists" here simply by having a directory under
 * workspaces/ — it doesn't need a store.json yet (e.g. once upload
 * exists, a workspace could have documents staged but nothing
 * embedded yet).
 * @returns {string[]}
 */
function listWorkspaces() {
  if (!fs.existsSync(WORKSPACES_ROOT)) return [];
  return fs
    .readdirSync(WORKSPACES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

module.exports = {
  WORKSPACES_ROOT,
  isValidWorkspaceId,
  workspaceDir,
  storePath,
  uploadsDir,
  ensureUploadsDir,
  ensureWorkspaceDir,
  listWorkspaces,
};
