# TestRail to Xray Migration Tool

A Node.js tool that automates the migration of test cases from TestRail to Xray (Jira Cloud).

## Overview

This tool reads test cases from a TestRail project and creates corresponding tests in Xray with:
- Native test steps (not plain text descriptions)
- Proper folder structure matching TestRail sections
- Automatic duplicate detection to prevent re-importing existing tests
- Round-robin assignment distribution among team members
- Labels for easy filtering and organization

## Setup

### 1. Environment Variables

Add to `~/.zshrc`:

```bash
# TestRail
export TESTRAIL_URL="https://sonian.testrail.com"    # Your TestRail instance URL
export TESTRAIL_EMAIL="your-email"                    # TestRail login email
export TESTRAIL_API_KEY="your-api-key"               # TestRail API key (Settings > API Keys)

# Xray
export XRAY_CLIENT_ID="your-client-id"               # Xray Cloud API client ID
export XRAY_CLIENT_SECRET="your-client-secret"       # Xray Cloud API client secret

# Jira
export JIRA_API_TOKEN="your-jira-api-token"          # Jira API token for duplicate detection
```

To create a Jira API token: https://id.atlassian.com/manage-profile/security/api-tokens

Then run: `source ~/.zshrc`

### 2. Install Dependencies

```bash
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

### Migrate Specific Section(s)

Migrates tests from one or more TestRail sections (folders). Supports single section or comma-separated list.

```bash
# Single section
node migrate-to-xray.js --section 114241

# Multiple sections
node migrate-to-xray.js --section 114241,114258,114261
```

### Migrate Limited Number of Tests

Restricts the migration to the first N test cases. Perfect for testing the migration process with a small batch before running the full migration.

```bash
node migrate-to-xray.js --limit 10
```

### Combine Options

Options can be combined for more control. For example, preview a small batch from specific sections before committing to the full migration.

```bash
# Preview single section with limit
node migrate-to-xray.js --section 114242 --limit 5 --dry-run

# Preview multiple sections
node migrate-to-xray.js --section 114241,114258 --dry-run

# Migrate multiple sections with limit
node migrate-to-xray.js --section 114241,114258 --limit 20
```

### Fix Folder Assignments

If tests are not appearing in the correct Xray Test Repository folders, use this script to fix them. It reads the folder information from each test's description and moves tests to their correct folders.

```bash
# Preview what will be fixed (no changes made)
node sync-xray-folders.js --dry-run

# Fix all folder assignments
node sync-xray-folders.js
```

The script:
- Fetches all tests with the `testrail-migrated` label
- Extracts the `Folder:` path from each test's description
- Creates folder hierarchy in Xray if needed
- Moves tests to correct folders in batches of 50

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
| 9 | Adds `testrail-migrated` label to all migrated tests |
| 10 | Skips duplicates (checks existing tests before migrating) |
| 11 | Assigns priority P4 to all tickets |
| 12 | Distributes tickets equally among assignees (round-robin) |

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
const TESTRAIL_PROJECT_ID = 72;    // TestRail project ID (Data Inspector)
const TESTRAIL_SUITE_ID = 651;     // TestRail suite ID (Master)
const JIRA_PROJECT_KEY = 'CODEUS'; // Jira project key for created tests
const JIRA_PROJECT_ID = '16433';   // Jira project ID (numeric)
const DEFAULT_PRIORITY = 'P4';     // Priority assigned to all tickets
```

To modify assignees, update the `ASSIGNEES` array in the script.

Edit these constants in `sync-xray-folders.js`:

```javascript
const JIRA_PROJECT_KEY = 'CODEUS';              // Jira project key to search for tests
const JIRA_PROJECT_ID = '16433';                // Jira project ID (numeric)
const JIRA_CLOUD_URL = 'https://cuda.atlassian.net'; // Jira Cloud instance URL
```

## Section IDs (Data Inspector)

| ID | Folder |
|----|--------|
| 114241 | Multi Tenant |
| 114242 | Multi Tenant/Login |
| 114258 | Detections |
| 114261 | Audit Log |
| 114262 | Scan log |
| 114266 | Policy Engine |
