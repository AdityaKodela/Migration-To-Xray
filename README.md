# TestRail to Xray Migration Tool

Migrates test cases from TestRail to Xray (Jira Cloud) with native test steps.

## Setup

### 1. Environment Variables

Add to `~/.zshrc`:

```bash
# TestRail
export TESTRAIL_URL="https://sonian.testrail.com"
export TESTRAIL_EMAIL="akodela@barracuda.com"
export TESTRAIL_API_KEY="your-api-key"

# Xray
export XRAY_CLIENT_ID="your-client-id"
export XRAY_CLIENT_SECRET="your-client-secret"

# Jira (for duplicate detection)
export JIRA_API_TOKEN="your-jira-api-token"
```

To create a Jira API token: https://id.atlassian.com/manage-profile/security/api-tokens

Then run: `source ~/.zshrc`

### 2. Install Dependencies

```bash
cd /Users/akodela/testrail-mcp-server
npm install
```

## Usage

### Preview Migration (Dry Run)
Simulates the migration without creating any tests in Xray. Use this to verify the migration will work correctly, see how many tests will be created, and preview the folder structure. No changes are made to Xray.

```bash
node migrate-to-xray.js --dry-run
```

### Migrate All Tests
Performs the full migration of all test cases from TestRail to Xray. Creates folder structure, imports tests with native steps, and assigns tests to appropriate folders. This may take 30-60 minutes depending on API rate limits.

```bash
node migrate-to-xray.js
```

### Migrate Specific Section Only
Migrates tests from a single TestRail section (folder) only. Useful for incremental migrations or testing specific areas. Use section IDs from the table below.

```bash
node migrate-to-xray.js --section 114050
```

### Migrate Limited Number of Tests
Restricts the migration to the first N test cases. Perfect for testing the migration process with a small batch before running the full migration.

```bash
node migrate-to-xray.js --limit 10
```

### Combine Options
Options can be combined for more control. For example, preview a small batch from a specific section before committing to the full migration.

```bash
node migrate-to-xray.js --section 114242 --limit 5 --dry-run
```

## Migration Rules

| # | Rule |
|---|------|
| 1 | Summary = test title only |
| 2 | Creates Test Repository folders matching TestRail structure |
| 3 | Description in plain text (no markdown) |
| 4 | Includes `TestCase Id: C{id}` in description |
| 5 | Includes `Folder: {path}` in description |
| 6 | Includes `Migrated from TestRail` in description |
| 7 | Auto-generates expected results if missing |
| 8 | Adds folder name as label (kebab-case) |
| 9 | Skips duplicates (checks existing tests before migrating) |
| 10 | Assigns priority P4 to all tickets |
| 11 | Distributes tickets equally among 4 assignees (round-robin) |

## Assignees

Tickets are distributed equally among the following team members:

| Name | Email |
|------|-------|
| Kodela Aditya | akodela@barracuda.com |
| Nithin A | nanand@barracuda.com |
| Shivantika - | shivantika@barracuda.com |
| Amrutha Channalli | achannalli@barracuda.com |

## Folder Exclusions

The following folders are automatically skipped during migration:

| Condition | Example |
|-----------|---------|
| Folder name contains "CODEUS" | `CODEUS-5000 — Renew the Let's Encrypt...` |
| Folder description contains "Auto-imported" | Auto-imported test folders |
| Folder description contains "Auto-generated" | `claude-generated-testcase` |

## Configuration

Edit these constants in `migrate-to-xray.js`:

```javascript
const TESTRAIL_PROJECT_ID = 72;    // Data Inspector
const TESTRAIL_SUITE_ID = 651;     // Master
const JIRA_PROJECT_KEY = 'CODEUS';
const JIRA_PROJECT_ID = '16433';
const DEFAULT_PRIORITY = 'P4';     // Priority for all tickets
```

To modify assignees, update the `ASSIGNEES` array in the script.

## Section IDs (Data Inspector)

| ID | Folder |
|----|--------|
| 114050 | Redaction Reveal |
| 114241 | Multi Tenant |
| 114242 | Multi Tenant/Login |
| 114258 | Detections |
| 114261 | Audit Log |
| 114262 | Scan log |
| 114266 | Policy Engine |

## Sample Output

```
============================================================
TestRail to Xray Migration
============================================================

Authenticating with Xray...
Authenticated successfully

Fetching already migrated tests from Xray...
  Scanned 100 existing tests...
Found 156 already migrated tests

Fetching test cases from TestRail...
  Fetched 250 test cases...
Found 1955 test cases

Skipping 156 already migrated tests
Remaining tests to migrate: 1799

Skipping folder: CODEUS-5000 — Renew the Let's Encrypt (3 tests)
  Reason: Folder name contains "CODEUS"

Processing: /Redaction Reveal (5 tests)
  Importing batch 1/1 (5 tests)...
    Created 5 tests
  Adding 5 tests to folder: /Redaction Reveal
  Successfully added all tests to folder

============================================================
Migration Summary
============================================================
Success:              1750
Failed:               0
Skipped (folders):    3 folders, 49 tests
Skipped (duplicates): 156
```

## Sample Tests Created

- CODEUS-5160 - Redaction Reveal (with existing steps)
- CODEUS-5164 - Multi Tenant/Login (with generated steps)
