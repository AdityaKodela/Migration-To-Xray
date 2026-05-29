#!/usr/bin/env node

/**
 * TestRail to Xray Migration Script
 *
 * Migrates test cases from TestRail to Xray (Jira Cloud) with:
 * - Native Xray test steps
 * - Test Repository folder structure
 * - Auto-generated expected results when missing
 *
 * Requirements:
 * Set these environment variables in ~/.zshrc:
 *   export TESTRAIL_URL="https://sonian.testrail.com"
 *   export TESTRAIL_EMAIL="your-email@company.com"
 *   export TESTRAIL_API_KEY="your-testrail-api-key"
 *   export XRAY_CLIENT_ID="your-xray-client-id"
 *   export XRAY_CLIENT_SECRET="your-xray-client-secret"
 *
 * Usage:
 *   node migrate-to-xray.js                    # Migrate all tests
 *   node migrate-to-xray.js --dry-run          # Preview without creating
 *   node migrate-to-xray.js --section 114050   # Migrate specific section only
 *   node migrate-to-xray.js --limit 10         # Migrate first N tests only
 */

const TESTRAIL_PROJECT_ID = 72;  // Data Inspector
const TESTRAIL_SUITE_ID = 651;   // Master
const JIRA_PROJECT_KEY = 'CODEUS';
const JIRA_PROJECT_ID = '16433';
const JIRA_CLOUD_URL = 'https://cuda.atlassian.net';
const DEFAULT_PRIORITY = 'P4';  // Priority for all migrated tests

// Assignees - tickets will be distributed equally among these users
const ASSIGNEES = [
  { accountId: '712020:c65cdc1d-ed01-4aac-bb5f-e1e97029b964', name: 'Kodela Aditya' },
  { accountId: '712020:779260aa-1d43-4915-a2ad-d7f93843778b', name: 'Nithin A' },
  { accountId: '712020:d2776ba2-83ed-4fce-9290-c7f44c004c7f', name: 'Shivantika -' },
  { accountId: '712020:c4344511-1b2e-4833-95c8-7171e8cf7fc1', name: 'Amrutha Channalli' }
];

// Counter for round-robin assignment
let assigneeIndex = 0;

function getNextAssignee() {
  const assignee = ASSIGNEES[assigneeIndex];
  assigneeIndex = (assigneeIndex + 1) % ASSIGNEES.length;
  return assignee;
}

// Check if a section should be skipped based on name or description
function shouldSkipSection(section) {
  const name = (section.name || '').toLowerCase();
  const description = (section.description || '').toLowerCase();

  // Skip if folder name contains "CODEUS"
  if (name.includes('codeus')) {
    return { skip: true, reason: 'Folder name contains "CODEUS"' };
  }

  // Skip if description contains "Auto-imported" or "Auto-generated"
  if (description.includes('auto-imported')) {
    return { skip: true, reason: 'Description contains "Auto-imported"' };
  }
  if (description.includes('auto-generated')) {
    return { skip: true, reason: 'Description contains "Auto-generated"' };
  }

  return { skip: false };
}

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SECTION_FILTER = args.includes('--section') ? parseInt(args[args.indexOf('--section') + 1]) : null;
const LIMIT = args.includes('--limit') ? parseInt(args[args.indexOf('--limit') + 1]) : null;

// TestRail API Client
class TestRailClient {
  constructor() {
    this.baseUrl = process.env.TESTRAIL_URL;
    this.auth = Buffer.from(`${process.env.TESTRAIL_EMAIL}:${process.env.TESTRAIL_API_KEY}`).toString('base64');
  }

  async request(endpoint) {
    const response = await fetch(`${this.baseUrl}/index.php?/api/v2/${endpoint}`, {
      headers: {
        'Authorization': `Basic ${this.auth}`,
        'Content-Type': 'application/json'
      }
    });
    return response.json();
  }

  async getSections(projectId, suiteId) {
    const result = await this.request(`get_sections/${projectId}&suite_id=${suiteId}`);
    return result.sections || result;
  }

  async getAllCases(projectId, suiteId, sectionId = null) {
    let allCases = [];
    let offset = 0;
    const limit = 250;

    while (true) {
      let endpoint = `get_cases/${projectId}&suite_id=${suiteId}&limit=${limit}&offset=${offset}`;
      if (sectionId) endpoint += `&section_id=${sectionId}`;

      const response = await this.request(endpoint);
      const cases = response.cases || response;

      if (!Array.isArray(cases) || cases.length === 0) break;
      allCases = allCases.concat(cases);
      console.log(`  Fetched ${allCases.length} test cases...`);

      if (cases.length < limit) break;
      offset += limit;
    }

    return allCases;
  }
}

// Jira API Client (for duplicate checking)
class JiraClient {
  constructor() {
    this.baseUrl = JIRA_CLOUD_URL;
    this.auth = Buffer.from(`${process.env.TESTRAIL_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  }

  async searchIssues(jql, nextPageToken = null, maxResults = 100) {
    // Using new /rest/api/3/search/jql endpoint (old /search endpoint is deprecated)
    const url = `${this.baseUrl}/rest/api/3/search/jql`;
    const body = {
      jql: jql,
      maxResults: maxResults,
      fields: ['description', 'summary']
    };

    if (nextPageToken) {
      body.nextPageToken = nextPageToken;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${this.auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return response.json();
  }

  // Extract text from Atlassian Document Format (ADF)
  extractTextFromADF(adfNode) {
    if (!adfNode) return '';
    if (typeof adfNode === 'string') return adfNode;

    let text = '';
    if (adfNode.text) {
      text += adfNode.text;
    }
    if (adfNode.content && Array.isArray(adfNode.content)) {
      for (const child of adfNode.content) {
        text += this.extractTextFromADF(child);
      }
    }
    return text;
  }

  async getExistingMigratedTestIds() {
    console.log('Fetching already migrated tests from Xray...');
    const migratedIds = new Set();
    let nextPageToken = null;
    let totalScanned = 0;

    // Search for all tests with testrail-migrated label in the project
    const jql = `project = ${JIRA_PROJECT_KEY} AND type = Test AND labels = testrail-migrated`;

    while (true) {
      const result = await this.searchIssues(jql, nextPageToken);

      if (result.errorMessages) {
        console.error('Jira API Error:', result.errorMessages);
        break;
      }

      if (!result.issues || result.issues.length === 0) break;

      // Extract TestRail case IDs from descriptions
      for (const issue of result.issues) {
        const description = issue.fields.description;
        if (description) {
          // Handle both plain text and Atlassian Document Format
          let descText = '';
          if (typeof description === 'string') {
            descText = description;
          } else if (description.content) {
            // ADF format - extract text properly
            descText = this.extractTextFromADF(description);
          }

          // Match "TestCase Id: C1234567" pattern
          const match = descText.match(/TestCase Id:\s*C(\d+)/i);
          if (match) {
            migratedIds.add(parseInt(match[1]));
          }
        }
      }

      totalScanned += result.issues.length;
      console.log(`  Scanned ${totalScanned} existing tests...`);

      // Check if there are more pages
      if (!result.nextPageToken) break;
      nextPageToken = result.nextPageToken;

      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`Found ${migratedIds.size} already migrated tests\n`);
    return migratedIds;
  }
}

// Xray API Client
class XrayClient {
  constructor() {
    this.token = null;
  }

  async authenticate() {
    const response = await fetch('https://xray.cloud.getxray.app/api/v2/authenticate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.XRAY_CLIENT_ID,
        client_secret: process.env.XRAY_CLIENT_SECRET
      })
    });
    this.token = await response.json();
    return this.token;
  }

  async graphql(query, variables = {}) {
    const response = await fetch('https://xray.cloud.getxray.app/api/v2/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify({ query, variables })
    });
    return response.json();
  }

  async createFolder(projectId, path) {
    const mutation = `
      mutation CreateFolder($projectId: String!, $path: String!) {
        createFolder(projectId: $projectId, path: $path) {
          folder { name path }
          warnings
        }
      }
    `;
    return this.graphql(mutation, { projectId, path });
  }

  async createTests(testData) {
    const response = await fetch('https://xray.cloud.getxray.app/api/v2/import/test/bulk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.token}`
      },
      body: JSON.stringify(testData)
    });
    return response.json();
  }

  async checkJobStatus(jobId) {
    const response = await fetch(`https://xray.cloud.getxray.app/api/v2/import/test/bulk/${jobId}/status`, {
      headers: { 'Authorization': `Bearer ${this.token}` }
    });
    return response.json();
  }

  async waitForJob(jobId, maxWait = 60000) {
    const start = Date.now();
    while (Date.now() - start < maxWait) {
      const status = await this.checkJobStatus(jobId);
      if (status.status === 'successful') return status;
      if (status.status === 'failed') throw new Error(`Job failed: ${JSON.stringify(status)}`);
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error('Job timeout');
  }

  async addTestsToFolder(testIssueIds, path, projectId) {
    const mutation = `
      mutation AddTestsToFolder($testIssueIds: [String]!, $path: String!, $projectId: String!) {
        addTestsToFolder(testIssueIds: $testIssueIds, path: $path, projectId: $projectId) {
          folder { name path }
          warnings
        }
      }
    `;
    return this.graphql(mutation, { testIssueIds, path, projectId });
  }
}

// Generate expected result based on action (as Principal Test Engineer)
function generateExpectedResult(action, testTitle) {
  const actionLower = action.toLowerCase();

  // Login/Authentication related
  if (actionLower.includes('login') || actionLower.includes('sign in')) {
    return 'User is successfully authenticated and redirected to the appropriate dashboard';
  }
  if (actionLower.includes('logout') || actionLower.includes('sign out')) {
    return 'User is successfully logged out and redirected to the login page';
  }

  // Navigation
  if (actionLower.includes('navigate') || actionLower.includes('go to') || actionLower.includes('open')) {
    return 'Page loads successfully and displays expected content';
  }
  if (actionLower.includes('click')) {
    if (actionLower.includes('button')) {
      return 'Button action is executed successfully and expected response is displayed';
    }
    if (actionLower.includes('link')) {
      return 'User is navigated to the expected destination';
    }
    return 'Click action is registered and appropriate response is displayed';
  }

  // Form inputs
  if (actionLower.includes('enter') || actionLower.includes('input') || actionLower.includes('type')) {
    return 'Input is accepted and displayed correctly in the field';
  }
  if (actionLower.includes('select') || actionLower.includes('choose')) {
    return 'Selection is applied and reflected in the UI';
  }
  if (actionLower.includes('submit')) {
    return 'Form is submitted successfully and confirmation is displayed';
  }

  // Verification
  if (actionLower.includes('verify') || actionLower.includes('check') || actionLower.includes('validate') || actionLower.includes('confirm')) {
    return 'Verification passes and expected state is confirmed';
  }
  if (actionLower.includes('should') || actionLower.includes('display') || actionLower.includes('show')) {
    return 'Expected content is displayed correctly';
  }

  // Data operations
  if (actionLower.includes('save') || actionLower.includes('create') || actionLower.includes('add')) {
    return 'Data is saved successfully and confirmation message is displayed';
  }
  if (actionLower.includes('delete') || actionLower.includes('remove')) {
    return 'Item is deleted successfully and no longer appears in the list';
  }
  if (actionLower.includes('update') || actionLower.includes('edit') || actionLower.includes('modify')) {
    return 'Changes are saved successfully and reflected in the UI';
  }
  if (actionLower.includes('search') || actionLower.includes('filter')) {
    return 'Search/filter results are displayed correctly based on criteria';
  }

  // File operations
  if (actionLower.includes('upload')) {
    return 'File is uploaded successfully and appears in the file list';
  }
  if (actionLower.includes('download')) {
    return 'File is downloaded successfully to the local system';
  }

  // Default based on test title context
  const titleLower = testTitle.toLowerCase();
  if (titleLower.includes('login')) {
    return 'Login operation completes successfully';
  }
  if (titleLower.includes('verify') || titleLower.includes('validate')) {
    return 'Validation passes successfully';
  }

  // Generic fallback
  return 'Action completes successfully with expected behavior';
}

// Parse steps from TestRail format
function parseSteps(customSteps, customExpected, testTitle) {
  const steps = [];

  if (!customSteps && !customExpected) {
    // No steps at all - generate based on test title
    steps.push({
      action: `Execute test: ${testTitle}`,
      data: '',
      result: generateExpectedResult(testTitle, testTitle)
    });
    return steps;
  }

  if (customSteps) {
    // Parse numbered steps (1. Step, 2. Step, etc.)
    const stepLines = customSteps.split(/\r?\n/).filter(line => line.trim());
    const stepActions = [];
    let currentStep = '';

    for (const line of stepLines) {
      const numberedMatch = line.match(/^\d+[\.\)]\s*(.+)/);
      if (numberedMatch) {
        if (currentStep) stepActions.push(currentStep.trim());
        currentStep = numberedMatch[1];
      } else if (line.trim().startsWith('-') || line.trim().startsWith('•')) {
        if (currentStep) stepActions.push(currentStep.trim());
        currentStep = line.replace(/^[-•]\s*/, '').trim();
      } else {
        currentStep += ' ' + line.trim();
      }
    }
    if (currentStep) stepActions.push(currentStep.trim());

    // If no numbered steps found, treat whole text as single step
    if (stepActions.length === 0) {
      stepActions.push(customSteps.trim());
    }

    // Create steps with expected results
    for (let i = 0; i < stepActions.length; i++) {
      const isLastStep = i === stepActions.length - 1;
      steps.push({
        action: stepActions[i],
        data: '',
        result: isLastStep && customExpected ? customExpected : generateExpectedResult(stepActions[i], testTitle)
      });
    }
  } else if (customExpected) {
    // Only expected result, no steps
    steps.push({
      action: `Execute test: ${testTitle}`,
      data: '',
      result: customExpected
    });
  }

  return steps;
}

// Convert folder name to label (kebab-case)
function folderToLabel(folderPath) {
  return folderPath
    .replace(/^\//, '')
    .replace(/\//g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Build folder path from section
function buildFolderPath(section, sectionsMap) {
  const parts = [section.name];
  let current = section;

  while (current.parent_id) {
    const parent = sectionsMap.get(current.parent_id);
    if (!parent) break;
    parts.unshift(parent.name);
    current = parent;
  }

  return '/' + parts.join('/');
}

// Main migration function
async function migrate() {
  console.log('='.repeat(60));
  console.log('TestRail to Xray Migration');
  console.log('='.repeat(60));

  if (DRY_RUN) console.log('\n*** DRY RUN MODE - No changes will be made ***\n');
  if (SECTION_FILTER) console.log(`Filtering to section ID: ${SECTION_FILTER}\n`);
  if (LIMIT) console.log(`Limiting to ${LIMIT} tests\n`);

  // Validate environment variables
  const required = ['TESTRAIL_URL', 'TESTRAIL_EMAIL', 'TESTRAIL_API_KEY', 'XRAY_CLIENT_ID', 'XRAY_CLIENT_SECRET', 'JIRA_API_TOKEN'];
  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    console.error('Add them to ~/.zshrc and run: source ~/.zshrc');
    if (missing.includes('JIRA_API_TOKEN')) {
      console.error('\nJIRA_API_TOKEN is required for duplicate detection.');
      console.error('Create one at: https://id.atlassian.com/manage-profile/security/api-tokens');
    }
    process.exit(1);
  }

  const testrail = new TestRailClient();
  const xray = new XrayClient();
  const jira = new JiraClient();

  // Authenticate with Xray
  console.log('Authenticating with Xray...');
  await xray.authenticate();
  console.log('Authenticated successfully\n');

  // Get already migrated test IDs to avoid duplicates
  const existingTestIds = await jira.getExistingMigratedTestIds();

  // Get sections from TestRail
  console.log('Fetching sections from TestRail...');
  const sections = await testrail.getSections(TESTRAIL_PROJECT_ID, TESTRAIL_SUITE_ID);
  const sectionsMap = new Map(sections.map(s => [s.id, s]));
  console.log(`Found ${sections.length} sections\n`);

  // Get test cases from TestRail
  console.log('Fetching test cases from TestRail...');
  let testCases = await testrail.getAllCases(TESTRAIL_PROJECT_ID, TESTRAIL_SUITE_ID, SECTION_FILTER);
  console.log(`Found ${testCases.length} test cases\n`);

  if (LIMIT) {
    testCases = testCases.slice(0, LIMIT);
    console.log(`Limited to ${testCases.length} test cases\n`);
  }

  // Filter out already migrated tests
  const originalCount = testCases.length;
  testCases = testCases.filter(tc => !existingTestIds.has(tc.id));
  const skippedDuplicates = originalCount - testCases.length;

  if (skippedDuplicates > 0) {
    console.log(`Skipping ${skippedDuplicates} already migrated tests`);
    console.log(`Remaining tests to migrate: ${testCases.length}\n`);
  }

  if (testCases.length === 0) {
    console.log('No new tests to migrate. All tests are already in Xray.');
    return;
  }

  // Group test cases by section for batch processing
  const casesBySection = new Map();
  for (const tc of testCases) {
    const sectionId = tc.section_id;
    if (!casesBySection.has(sectionId)) {
      casesBySection.set(sectionId, []);
    }
    casesBySection.get(sectionId).push(tc);
  }

  // Create folders and migrate tests
  const results = {
    success: 0,
    failed: 0,
    skipped: 0,
    skippedFolders: 0,
    duplicatesSkipped: skippedDuplicates,
    errors: []
  };

  const createdFolders = new Set();

  for (const [sectionId, cases] of casesBySection) {
    const section = sectionsMap.get(sectionId);
    if (!section) {
      console.log(`Skipping ${cases.length} cases - section ${sectionId} not found`);
      results.skipped += cases.length;
      continue;
    }

    // Check if this section should be skipped
    const skipCheck = shouldSkipSection(section);
    if (skipCheck.skip) {
      console.log(`\nSkipping folder: ${section.name} (${cases.length} tests)`);
      console.log(`  Reason: ${skipCheck.reason}`);
      results.skippedFolders++;
      results.skipped += cases.length;
      continue;
    }

    const folderPath = buildFolderPath(section, sectionsMap);
    const folderLabel = folderToLabel(folderPath);

    console.log(`\nProcessing: ${folderPath} (${cases.length} tests)`);

    // Create folder hierarchy
    if (!DRY_RUN && !createdFolders.has(folderPath)) {
      const pathParts = folderPath.split('/').filter(p => p);
      let currentPath = '';
      for (const part of pathParts) {
        currentPath += '/' + part;
        if (!createdFolders.has(currentPath)) {
          await xray.createFolder(JIRA_PROJECT_ID, currentPath);
          createdFolders.add(currentPath);
        }
      }
    }

    // Prepare test data for bulk import
    const testData = cases.map(tc => {
      const steps = parseSteps(tc.custom_steps, tc.custom_expected, tc.title);

      const assignee = getNextAssignee();
      return {
        testtype: 'Manual',
        fields: {
          summary: tc.title,
          project: { key: JIRA_PROJECT_KEY },
          description: `Migrated from TestRail\n\nTestCase Id: C${tc.id}\nFolder: ${folderPath.replace(/^\//, '')}`,
          labels: ['testrail-migrated', folderLabel].filter(l => l),
          priority: { name: DEFAULT_PRIORITY },
          assignee: { accountId: assignee.accountId }
        },
        steps: steps
      };
    });

    if (DRY_RUN) {
      console.log(`  Would create ${testData.length} tests`);
      testData.slice(0, 2).forEach((t, i) => {
        console.log(`    ${i + 1}. ${t.fields.summary}`);
        console.log(`       Steps: ${t.steps.length}`);
      });
      if (testData.length > 2) console.log(`    ... and ${testData.length - 2} more`);
      results.success += testData.length;
      continue;
    }

    // Collect all issue IDs for this section across all batches
    const allIssueIdsForSection = [];

    // Import tests in batches of 50
    const BATCH_SIZE = 50;
    for (let i = 0; i < testData.length; i += BATCH_SIZE) {
      const batch = testData.slice(i, i + BATCH_SIZE);
      console.log(`  Importing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(testData.length / BATCH_SIZE)} (${batch.length} tests)...`);

      try {
        const job = await xray.createTests(batch);
        const status = await xray.waitForJob(job.jobId);

        if (status.result.issues.length > 0) {
          // Collect issue IDs - don't add to folder yet
          const issueIds = status.result.issues.map(i => i.id);
          allIssueIdsForSection.push(...issueIds);

          results.success += status.result.issues.length;
          console.log(`    Created ${status.result.issues.length} tests`);
        }

        if (status.result.errors.length > 0) {
          results.failed += status.result.errors.length;
          results.errors.push(...status.result.errors);
          console.log(`    Errors: ${status.result.errors.length}`);
        }

        // Rate limiting - wait between batches
        await new Promise(r => setTimeout(r, 1000));

      } catch (error) {
        console.log(`    Error: ${error.message}`);
        results.failed += batch.length;
        results.errors.push({ batch: i, error: error.message });
      }
    }

    // After all batches complete, add ALL tests to folder at once
    if (allIssueIdsForSection.length > 0) {
      console.log(`  Adding ${allIssueIdsForSection.length} tests to folder: ${folderPath}`);
      try {
        // Add tests to folder in chunks of 100 to avoid API limits
        const FOLDER_BATCH_SIZE = 100;
        for (let i = 0; i < allIssueIdsForSection.length; i += FOLDER_BATCH_SIZE) {
          const chunk = allIssueIdsForSection.slice(i, i + FOLDER_BATCH_SIZE);
          await xray.addTestsToFolder(chunk, folderPath, JIRA_PROJECT_ID);
          if (allIssueIdsForSection.length > FOLDER_BATCH_SIZE) {
            console.log(`    Added chunk ${Math.floor(i / FOLDER_BATCH_SIZE) + 1}/${Math.ceil(allIssueIdsForSection.length / FOLDER_BATCH_SIZE)} to folder`);
          }
          // Small delay between folder operations
          await new Promise(r => setTimeout(r, 500));
        }
        console.log(`  Successfully added all tests to folder`);
      } catch (error) {
        console.log(`  Error adding tests to folder: ${error.message}`);
        results.errors.push({ folder: folderPath, error: error.message });
      }
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(60));
  console.log('Migration Summary');
  console.log('='.repeat(60));
  console.log(`Success:              ${results.success}`);
  console.log(`Failed:               ${results.failed}`);
  console.log(`Skipped (folders):    ${results.skippedFolders} folders, ${results.skipped} tests`);
  console.log(`Skipped (duplicates): ${results.duplicatesSkipped}`);

  if (results.errors.length > 0) {
    console.log('\nErrors:');
    results.errors.slice(0, 10).forEach(e => console.log(`  - ${JSON.stringify(e)}`));
    if (results.errors.length > 10) {
      console.log(`  ... and ${results.errors.length - 10} more errors`);
    }
  }

  if (DRY_RUN) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
    console.log('Run without --dry-run to perform actual migration');
  }
}

// Run migration
migrate().catch(error => {
  console.error('Migration failed:', error);
  process.exit(1);
});
