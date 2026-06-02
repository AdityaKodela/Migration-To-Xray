#!/usr/bin/env node

/**
 * Folder Count Validation
 *
 * Compares direct test counts per folder between TestRail (source) and Xray
 * (migrated, identified by the `testrail-migrated` label + `Folder:` line in
 * the test description). Counts are direct — tests in subfolders are not
 * rolled up to their parent.
 *
 * Usage:
 *   node validate-folder-counts.js
 *   node validate-folder-counts.js --investigate "/Redaction Reveal"
 *   node validate-folder-counts.js --investigate-all
 *
 * --investigate prints the per-TestCase-ID diff for a single folder so you
 * can see which IDs explain a mismatch (deleted in TestRail, moved to a
 * different section, or never migrated).
 * --investigate-all does the same for every folder with a non-zero diff
 * (SKIPPED and OK folders are excluded).
 */

const TESTRAIL_PROJECT_ID = 72;
const TESTRAIL_SUITE_ID = 651;
const JIRA_PROJECT_KEY = 'CODEUS';
const JIRA_CLOUD_URL = 'https://cuda.atlassian.net';

const args = process.argv.slice(2);
const investigateIdx = args.indexOf('--investigate');
const INVESTIGATE = investigateIdx >= 0 ? args[investigateIdx + 1] : null;
const INVESTIGATE_ALL = args.includes('--investigate-all');

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

  async getAllCases(projectId, suiteId) {
    let allCases = [];
    let offset = 0;
    const limit = 250;
    while (true) {
      const endpoint = `get_cases/${projectId}&suite_id=${suiteId}&limit=${limit}&offset=${offset}`;
      const response = await this.request(endpoint);
      const cases = response.cases || response;
      if (!Array.isArray(cases) || cases.length === 0) break;
      allCases = allCases.concat(cases);
      console.log(`  Fetched ${allCases.length} TestRail cases...`);
      if (cases.length < limit) break;
      offset += limit;
    }
    return allCases;
  }
}

class JiraClient {
  constructor() {
    this.baseUrl = JIRA_CLOUD_URL;
    this.auth = Buffer.from(`${process.env.TESTRAIL_EMAIL}:${process.env.JIRA_API_TOKEN}`).toString('base64');
  }

  async searchIssues(jql, nextPageToken = null) {
    const body = { jql, maxResults: 100, fields: ['description', 'summary'] };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const response = await fetch(`${this.baseUrl}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${this.auth}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    return response.json();
  }

  extractTextFromADF(node) {
    if (!node) return '';
    if (typeof node === 'string') return node;
    let text = '';
    if (node.text) text += node.text;
    if (node.content && Array.isArray(node.content)) {
      for (const c of node.content) text += this.extractTextFromADF(c);
    }
    return text;
  }

  async getAllMigratedTests() {
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
        if (typeof description === 'string') descText = description;
        else if (description && description.content) descText = this.extractTextFromADF(description);
        const folderMatch = descText.match(/Folder:\s*(.+?)(?:\n|$)/i);
        const caseIdMatch = descText.match(/TestCase Id:\s*C(\d+)/i);
        tests.push({
          key: issue.key,
          summary: issue.fields.summary || '',
          folder: folderMatch ? '/' + folderMatch[1].trim() : null,
          caseId: caseIdMatch ? parseInt(caseIdMatch[1]) : null
        });
      }
      console.log(`  Fetched ${tests.length} Xray tests...`);
      if (!result.nextPageToken) break;
      nextPageToken = result.nextPageToken;
      await new Promise(r => setTimeout(r, 200));
    }
    return tests;
  }
}

// Same skip logic as migrate-to-xray.js — keep these in sync.
function shouldSkipSection(section) {
  const name = (section.name || '').toLowerCase();
  const description = (section.description || '').toLowerCase();
  if (name.includes('codeus')) return { skip: true, reason: 'CODEUS name' };
  if (description.includes('auto-imported')) return { skip: true, reason: 'Auto-imported' };
  if (description.includes('auto-generated')) return { skip: true, reason: 'Auto-generated' };
  return { skip: false };
}

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

async function main() {
  const required = ['TESTRAIL_URL', 'TESTRAIL_EMAIL', 'TESTRAIL_API_KEY', 'JIRA_API_TOKEN'];
  const missing = required.filter(v => !process.env[v]);
  if (missing.length > 0) {
    console.error(`Missing env vars: ${missing.join(', ')}`);
    process.exit(1);
  }

  const testrail = new TestRailClient();
  const jira = new JiraClient();

  console.log('Fetching TestRail sections...');
  const sections = await testrail.getSections(TESTRAIL_PROJECT_ID, TESTRAIL_SUITE_ID);
  const sectionsMap = new Map(sections.map(s => [s.id, s]));
  console.log(`  Found ${sections.length} sections\n`);

  console.log('Fetching TestRail cases...');
  const cases = await testrail.getAllCases(TESTRAIL_PROJECT_ID, TESTRAIL_SUITE_ID);
  console.log(`  Found ${cases.length} cases\n`);

  console.log('Fetching migrated tests from Jira...');
  const xrayTests = await jira.getAllMigratedTests();
  console.log(`  Found ${xrayTests.length} migrated tests\n`);

  // TestRail: cases grouped by folder + lookup by case ID
  const testrailCasesByFolder = new Map();
  const testrailCaseById = new Map();
  for (const c of cases) {
    const section = sectionsMap.get(c.section_id);
    if (!section) continue;
    const path = buildFolderPath(section, sectionsMap);
    if (!testrailCasesByFolder.has(path)) testrailCasesByFolder.set(path, []);
    testrailCasesByFolder.get(path).push(c);
    testrailCaseById.set(c.id, { case: c, folder: path });
  }

  // Xray: tests grouped by folder
  const xrayTestsByFolder = new Map();
  for (const t of xrayTests) {
    if (!t.folder) continue;
    if (!xrayTestsByFolder.has(t.folder)) xrayTestsByFolder.set(t.folder, []);
    xrayTestsByFolder.get(t.folder).push(t);
  }

  // Skip-reason index by folder path
  const skipReasonByPath = new Map();
  for (const s of sections) {
    const sk = shouldSkipSection(s);
    if (sk.skip) {
      const path = buildFolderPath(s, sectionsMap);
      skipReasonByPath.set(path, sk.reason);
    }
  }

  const allFolders = new Set([...testrailCasesByFolder.keys(), ...xrayTestsByFolder.keys()]);

  const rows = [];
  for (const folder of Array.from(allFolders).sort()) {
    const tr = (testrailCasesByFolder.get(folder) || []).length;
    const xr = (xrayTestsByFolder.get(folder) || []).length;
    const skipReason = skipReasonByPath.get(folder);
    let status;
    if (skipReason) status = `SKIPPED (${skipReason})`;
    else if (tr === xr) status = 'OK';
    else status = `MISMATCH (${xr - tr >= 0 ? '+' : ''}${xr - tr})`;
    rows.push({ folder, tr, xr, status });
  }

  const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
  const padNum = (s, n) => ' '.repeat(Math.max(0, n - String(s).length)) + String(s);

  const folderW = Math.max('Folder'.length, ...rows.map(r => r.folder.length));
  const trW = Math.max('TestRail'.length, ...rows.map(r => String(r.tr).length));
  const xrW = Math.max('Xray'.length, ...rows.map(r => String(r.xr).length));
  const statusW = Math.max('Status'.length, ...rows.map(r => r.status.length));

  const sep = `+-${'-'.repeat(folderW)}-+-${'-'.repeat(trW)}-+-${'-'.repeat(xrW)}-+-${'-'.repeat(statusW)}-+`;
  console.log(sep);
  console.log(`| ${pad('Folder', folderW)} | ${pad('TestRail', trW)} | ${pad('Xray', xrW)} | ${pad('Status', statusW)} |`);
  console.log(sep);
  for (const r of rows) {
    console.log(`| ${pad(r.folder, folderW)} | ${padNum(r.tr, trW)} | ${padNum(r.xr, xrW)} | ${pad(r.status, statusW)} |`);
  }
  console.log(sep);

  const trTotal = rows.reduce((a, r) => a + r.tr, 0);
  const xrTotal = rows.reduce((a, r) => a + r.xr, 0);
  const okCount = rows.filter(r => r.status === 'OK').length;
  const mismatchCount = rows.filter(r => r.status.startsWith('MISMATCH')).length;
  const skipCount = rows.filter(r => r.status.startsWith('SKIPPED')).length;
  const expectedMigrated = rows
    .filter(r => !r.status.startsWith('SKIPPED'))
    .reduce((a, r) => a + r.tr, 0);

  console.log(`\nTotal TestRail cases: ${trTotal}`);
  console.log(`Total Xray tests:     ${xrTotal}`);
  console.log(`Expected migrated (TestRail minus SKIPPED folders): ${expectedMigrated}`);
  console.log(`Folders OK:        ${okCount}`);
  console.log(`Folders MISMATCH:  ${mismatchCount}`);
  console.log(`Folders SKIPPED:   ${skipCount}`);

  if (INVESTIGATE) {
    const path = INVESTIGATE.startsWith('/') ? INVESTIGATE : '/' + INVESTIGATE;
    investigateFolder(path, testrailCasesByFolder, xrayTestsByFolder, testrailCaseById);
  }

  if (INVESTIGATE_ALL) {
    const mismatched = rows.filter(r => r.status.startsWith('MISMATCH'));
    if (mismatched.length === 0) {
      console.log('\n--investigate-all: no MISMATCH folders to investigate.');
    } else {
      console.log(`\n--investigate-all: ${mismatched.length} folder(s) with non-zero diff`);
      for (const r of mismatched) {
        investigateFolder(r.folder, testrailCasesByFolder, xrayTestsByFolder, testrailCaseById);
      }
    }
  }
}

function investigateFolder(path, testrailCasesByFolder, xrayTestsByFolder, testrailCaseById) {
  console.log('\n' + '='.repeat(60));
  console.log(`Investigating: ${path}`);
  console.log('='.repeat(60));

  const trCases = testrailCasesByFolder.get(path) || [];
  const xrTests = xrayTestsByFolder.get(path) || [];

  if (trCases.length === 0 && xrTests.length === 0) {
    console.log(`\nNo data found for folder ${path}. Check the exact path printed in the table above.`);
    return;
  }

  const trIds = new Set(trCases.map(c => c.id));
  const xrIds = new Set(xrTests.map(t => t.caseId).filter(x => x != null));

  const xrayOnly = xrTests.filter(t => t.caseId != null && !trIds.has(t.caseId));
  const trOnly = trCases.filter(c => !xrIds.has(c.id));
  const xrayWithoutId = xrTests.filter(t => t.caseId == null);

  console.log(`\nTestRail cases here: ${trCases.length}`);
  console.log(`Xray tests here:     ${xrTests.length}`);
  console.log(`Xray-only (TestCase ID not in this TestRail section): ${xrayOnly.length}`);
  console.log(`TestRail-only (case in section but not migrated):     ${trOnly.length}`);
  if (xrayWithoutId.length > 0) {
    console.log(`Xray tests missing TestCase Id in description:        ${xrayWithoutId.length}`);
  }

  if (xrayOnly.length > 0) {
    console.log('\nXray-only TestCase IDs — where are they in TestRail now?');
    for (const t of xrayOnly) {
      const elsewhere = testrailCaseById.get(t.caseId);
      const where = elsewhere
        ? `moved to ${elsewhere.folder}`
        : 'NOT IN TESTRAIL (deleted or never existed)';
      console.log(`  C${t.caseId}  ${t.key}  ${where}`);
      console.log(`    Xray summary: ${t.summary}`);
    }
  }

  if (trOnly.length > 0) {
    console.log('\nTestRail-only case IDs (in section but not migrated):');
    for (const c of trOnly) {
      console.log(`  C${c.id}  ${c.title}`);
    }
  }

  if (xrayWithoutId.length > 0) {
    console.log('\nXray tests missing TestCase Id in description:');
    for (const t of xrayWithoutId) {
      console.log(`  ${t.key}  ${t.summary}`);
    }
  }
}

main().catch(e => {
  console.error('Validation failed:', e);
  process.exit(1);
});
