#!/usr/bin/env node

/**
 * Sync Xray Folders Script
 *
 * This script finds all migrated tests and ensures they are in the correct
 * Xray Test Repository folder based on their description.
 *
 * Usage:
 *   node sync-xray-folders.js --dry-run    # Preview changes without making them
 *   node sync-xray-folders.js              # Sync all folder assignments
 */

const JIRA_PROJECT_KEY = 'CODEUS';
const JIRA_PROJECT_ID = '16433';
const JIRA_CLOUD_URL = 'https://cuda.atlassian.net';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

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

  async getTestFolder(issueId, projectId) {
    const query = `
      query GetTest($issueId: String!, $projectId: String!) {
        getTests(jql: "id = ${issueId}", projectId: $projectId, limit: 1) {
          results {
            issueId
            folder {
              name
              path
            }
          }
        }
      }
    `;
    return this.graphql(query, { issueId, projectId });
  }
}

// Jira API Client
class JiraClient {
  constructor() {
    this.baseUrl = JIRA_CLOUD_URL;
    this.auth = Buffer.from(`${process.env.TESTRAIL_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  }

  async searchIssues(jql, nextPageToken = null, maxResults = 100) {
    const url = `${this.baseUrl}/rest/api/3/search/jql`;
    const body = {
      jql: jql,
      maxResults: maxResults,
      fields: ['description', 'summary', 'labels']
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

  extractTextFromADF(adfNode) {
    if (!adfNode) return '';
    if (typeof adfNode === 'string') return adfNode;
    let text = '';
    if (adfNode.text) text += adfNode.text;
    if (adfNode.content && Array.isArray(adfNode.content)) {
      for (const child of adfNode.content) {
        text += this.extractTextFromADF(child);
      }
    }
    return text;
  }

  async getAllMigratedTests() {
    console.log('Fetching all migrated tests from Jira...');
    const tests = [];
    let nextPageToken = null;

    const jql = `project = ${JIRA_PROJECT_KEY} AND type = Test AND labels = testrail-migrated`;

    while (true) {
      const result = await this.searchIssues(jql, nextPageToken);

      if (result.errorMessages) {
        console.error('Jira API Error:', result.errorMessages);
        break;
      }

      if (!result.issues || result.issues.length === 0) break;

      for (const issue of result.issues) {
        const description = issue.fields.description;
        let descText = '';
        if (typeof description === 'string') {
          descText = description;
        } else if (description && description.content) {
          descText = this.extractTextFromADF(description);
        }

        // Extract folder from description
        const folderMatch = descText.match(/Folder:\s*(.+?)(?:\n|$)/i);
        const folder = folderMatch ? folderMatch[1].trim() : null;

        tests.push({
          id: issue.id,
          key: issue.key,
          summary: issue.fields.summary,
          folder: folder,
          folderPath: folder ? '/' + folder : null
        });
      }

      console.log(`  Fetched ${tests.length} tests...`);

      if (!result.nextPageToken) break;
      nextPageToken = result.nextPageToken;

      await new Promise(r => setTimeout(r, 200));
    }

    return tests;
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('Fix Folder Assignments');
  console.log('='.repeat(60));

  if (DRY_RUN) {
    console.log('\n*** DRY RUN MODE - No changes will be made ***\n');
  }

  // Validate environment variables
  const required = ['TESTRAIL_EMAIL', 'JIRA_API_TOKEN', 'XRAY_CLIENT_ID', 'XRAY_CLIENT_SECRET'];
  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  const jira = new JiraClient();
  const xray = new XrayClient();

  // Authenticate with Xray
  console.log('Authenticating with Xray...');
  await xray.authenticate();
  console.log('Authenticated successfully\n');

  // Get all migrated tests
  const tests = await jira.getAllMigratedTests();
  console.log(`\nFound ${tests.length} migrated tests\n`);

  // Group tests by folder
  const testsByFolder = new Map();
  let testsWithoutFolder = 0;

  for (const test of tests) {
    if (!test.folderPath) {
      testsWithoutFolder++;
      continue;
    }

    if (!testsByFolder.has(test.folderPath)) {
      testsByFolder.set(test.folderPath, []);
    }
    testsByFolder.get(test.folderPath).push(test);
  }

  console.log(`Tests grouped into ${testsByFolder.size} folders`);
  console.log(`Tests without folder info: ${testsWithoutFolder}\n`);

  // Process each folder
  const createdFolders = new Set();
  let fixed = 0;
  let errors = 0;

  for (const [folderPath, folderTests] of testsByFolder) {
    console.log(`\nProcessing: ${folderPath} (${folderTests.length} tests)`);

    if (DRY_RUN) {
      console.log(`  Would add ${folderTests.length} tests to folder`);
      fixed += folderTests.length;
      continue;
    }

    // Create folder hierarchy if needed
    const pathParts = folderPath.split('/').filter(p => p);
    let currentPath = '';
    for (const part of pathParts) {
      currentPath += '/' + part;
      if (!createdFolders.has(currentPath)) {
        const result = await xray.createFolder(JIRA_PROJECT_ID, currentPath);
        if (result.errors && !result.errors[0]?.message?.includes('already exists')) {
          console.log(`  Warning creating folder ${currentPath}:`, result.errors);
        }
        createdFolders.add(currentPath);
      }
    }

    // Add tests to folder in chunks
    const CHUNK_SIZE = 50;
    const issueIds = folderTests.map(t => t.id);

    for (let i = 0; i < issueIds.length; i += CHUNK_SIZE) {
      const chunk = issueIds.slice(i, i + CHUNK_SIZE);

      try {
        const result = await xray.addTestsToFolder(chunk, folderPath, JIRA_PROJECT_ID);

        if (result.errors) {
          console.log(`  Error adding tests to folder:`, result.errors);
          errors += chunk.length;
        } else {
          fixed += chunk.length;
          console.log(`  Added ${chunk.length} tests to folder (${i + chunk.length}/${issueIds.length})`);
        }
      } catch (error) {
        console.log(`  Error: ${error.message}`);
        errors += chunk.length;
      }

      // Rate limiting
      await new Promise(r => setTimeout(r, 500));
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Fixed: ${fixed}`);
  console.log(`Errors: ${errors}`);
  console.log(`No folder info: ${testsWithoutFolder}`);

  if (DRY_RUN) {
    console.log('\n*** This was a DRY RUN - no changes were made ***');
  }
}

main().catch(error => {
  console.error('Script failed:', error);
  process.exit(1);
});
