/**
 * constants.js
 *
 * Central place for storage keys, message types, statuses and other
 * shared literal values. Nothing in this file may ever contain a secret -
 * it is loaded everywhere, including the content script.
 *
 * Every shared module attaches itself to one global namespace `LGS`
 * (LeetCode GitHub Sync). The same plain <script> files are loaded, in
 * dependency order, from content scripts, the background service worker
 * (importScripts) and the extension pages - no bundler required.
 */
(function (global) {
  const LGS = global.LGS || (global.LGS = {});

  const VERSION = '3.0.1';

  const STORAGE_KEYS = {
    GITHUB_CONFIG: 'githubConfig',
    SETTINGS: 'settings',
    SYNC_HISTORY: 'syncHistory',
    SOLUTION_INDEX: 'solutionIndex',
    PENDING_DECISIONS: 'pendingDecisions',
    HISTORICAL_PROGRESS: 'historicalProgress',
    HISTORICAL_DISCOVERY: 'historicalDiscovery',
    HISTORICAL_REPORT: 'historicalReport',
    HISTORICAL_QUEUE: 'historicalSyncQueue',
    SYNCED_SUBMISSION_IDS: 'syncedSubmissionIds',
    RETRY_LIST: 'retryList',
    LEETCODE_STATS: 'leetcodeStats',
    EVENTS: 'activityEvents',
    PROBLEMS: 'solvedProblems',
    SAVE_QUEUE: 'githubSaveQueue',
    LIVE_SUBMISSION: 'liveSubmission',
    STATS_META: 'statsMeta',
    OPENED_TABS: 'openedTabs',
    DIAGNOSTICS: 'diagnosticsReport',
    DEBUG_LOG_PREFIX: 'debugLog_',
    // Kept only so old v1 data can be cleaned up.
    LEGACY_SYNC_QUEUE: 'syncQueue',
    LEGACY_DEBUG_LOG: 'debugLog'
  };

  const DEFAULT_SETTINGS = {
    autoSync: true,
    duplicateHandling: 'update', // 'skip' | 'update' | 'ask'
    generateProblemReadme: true,
    updateRepoReadme: true,
    generateTopicIndex: true,
    historicalStrategy: 'latest', // 'latest' | 'first'
    historicalPageSize: 20,
    discoverySource: 'auto', // 'auto' | 'rest' | 'graphql'
    maxCandidatesPerProblem: 8,
    leetcodeRequestDelayMs: 700,
    githubWriteDelayMs: 1000,
    notifications: true,
    dailyGoal: 0, // 0 = no goal
    showFloatingPanel: true,
    debugLogging: false
  };

  const SETTING_LIMITS = {
    historicalPageSize: { min: 5, max: 100 },
    maxCandidatesPerProblem: { min: 1, max: 30 },
    leetcodeRequestDelayMs: { min: 0, max: 10000 },
    githubWriteDelayMs: { min: 0, max: 10000 },
    dailyGoal: { min: 0, max: 100 }
  };

  const SETTING_ENUMS = {
    duplicateHandling: ['skip', 'update', 'ask'],
    historicalStrategy: ['latest', 'first'],
    discoverySource: ['auto', 'rest', 'graphql']
  };

  const LEETCODE_STATUS = {
    PENDING: 'Pending',
    JUDGING: 'Judging',
    ACCEPTED: 'Accepted',
    WRONG_ANSWER: 'Wrong Answer',
    TIME_LIMIT_EXCEEDED: 'Time Limit Exceeded',
    MEMORY_LIMIT_EXCEEDED: 'Memory Limit Exceeded',
    RUNTIME_ERROR: 'Runtime Error',
    COMPILE_ERROR: 'Compile Error',
    OUTPUT_LIMIT_EXCEEDED: 'Output Limit Exceeded',
    UNKNOWN_ERROR: 'Unknown Error'
  };

  const IN_PROGRESS_STATUSES = new Set([LEETCODE_STATUS.PENDING, LEETCODE_STATUS.JUDGING]);
  const ACCEPTED_STATUS = LEETCODE_STATUS.ACCEPTED;

  const MSG = {
    // content script <-> background
    SUBMISSION_RESULT: 'SUBMISSION_RESULT',
    SUBMISSION_STATUS: 'SUBMISSION_STATUS',
    CONTENT_READY: 'CONTENT_READY',
    LEETCODE_REQUEST: 'LEETCODE_REQUEST',
    LEETCODE_PING: 'LEETCODE_PING',
    LEETCODE_GET_CURRENT_STATE: 'LEETCODE_GET_CURRENT_STATE',

    // extension pages -> background
    GET_STATE: 'GET_STATE',
    SAVE_GITHUB_CONFIG: 'SAVE_GITHUB_CONFIG',
    CLEAR_GITHUB_CONFIG: 'CLEAR_GITHUB_CONFIG',
    TEST_GITHUB_CONNECTION: 'TEST_GITHUB_CONNECTION',
    SAVE_SETTINGS: 'SAVE_SETTINGS',
    GET_SETTINGS: 'GET_SETTINGS',
    SYNC_CURRENT: 'SYNC_CURRENT',
    SYNC_PROBLEM: 'SYNC_PROBLEM',
    SYNC_HISTORICAL_START: 'SYNC_HISTORICAL_START',
    SYNC_HISTORICAL_PAUSE: 'SYNC_HISTORICAL_PAUSE',
    SYNC_HISTORICAL_RESUME: 'SYNC_HISTORICAL_RESUME',
    SYNC_HISTORICAL_CANCEL: 'SYNC_HISTORICAL_CANCEL',
    GET_HISTORICAL_PROGRESS: 'GET_HISTORICAL_PROGRESS',
    GET_HISTORICAL_REPORT: 'GET_HISTORICAL_REPORT',
    RETRY_FAILED: 'RETRY_FAILED',
    GET_FAILED_ITEMS: 'GET_FAILED_ITEMS',
    CLEAR_FAILED_ITEMS: 'CLEAR_FAILED_ITEMS',
    GET_PENDING_DECISIONS: 'GET_PENDING_DECISIONS',
    RESOLVE_DECISION: 'RESOLVE_DECISION',
    REBUILD_INDEX: 'REBUILD_INDEX',
    REGENERATE_READMES: 'REGENERATE_READMES',
    VERIFY_COVERAGE: 'VERIFY_COVERAGE',
    GET_INDEX: 'GET_INDEX',
    RUN_DIAGNOSTICS: 'RUN_DIAGNOSTICS',
    GET_LOGS: 'GET_LOGS',
    CLEAR_LOGS: 'CLEAR_LOGS',
    RESET_LOCAL_DATA: 'RESET_LOCAL_DATA',
    GET_SYNC_HISTORY: 'GET_SYNC_HISTORY',
    OPEN_DASHBOARD: 'OPEN_DASHBOARD',
    GET_STATS: 'GET_STATS',
    GET_PROBLEMS: 'GET_PROBLEMS',
    REFRESH_STATS: 'REFRESH_STATS',
    RETRY_SAVE: 'RETRY_SAVE',

    // broadcasts
    STATE_UPDATED: 'STATE_UPDATED',
    HISTORICAL_PROGRESS_UPDATED: 'HISTORICAL_PROGRESS_UPDATED',
    SYNC_HISTORY_UPDATED: 'SYNC_HISTORY_UPDATED'
  };

  const GITHUB_API_BASE = 'https://api.github.com';
  const LEETCODE_ORIGIN = 'https://leetcode.com';
  const DIFFICULTY_FOLDERS = { Easy: 'Easy', Medium: 'Medium', Hard: 'Hard' };
  const README_MARKERS = {
    START: '<!-- LEETCODE-SYNC-START -->',
    END: '<!-- LEETCODE-SYNC-END -->'
  };

  const JOB_ALARM = 'lgs-job-tick';
  const WAKE_ALARM = 'lgs-job-wake';
  const SAVE_ALARM = 'lgs-save-tick';

  const CONSTS = {
    VERSION, STORAGE_KEYS, DEFAULT_SETTINGS, SETTING_LIMITS, SETTING_ENUMS,
    LEETCODE_STATUS, IN_PROGRESS_STATUSES, ACCEPTED_STATUS, MSG,
    GITHUB_API_BASE, LEETCODE_ORIGIN, DIFFICULTY_FOLDERS, README_MARKERS,
    JOB_ALARM, WAKE_ALARM, SAVE_ALARM,
    MAX_EVENTS: 30000,
    SOLVED_CONFIRM_DELAY_MS: 2000,
    SOLVED_CONFIRM_TRIES: 8,
    STATS_STALE_MS: 30 * 60 * 1000,
    SAVE_RETRY_DELAYS_MS: [30000, 60000, 180000, 600000, 1800000, 3600000, 7200000],
    POLL_INTERVAL_MS: 1500,
    POLL_TIMEOUT_MS: 60000,
    MAX_DISCOVERY_PAGES: 3000,
    MAX_RETRY_ATTEMPTS: 3,
    RETRY_BASE_DELAY_MS: 1000,
    // Waits longer than this are not slept in-process; the job parks
    // itself in the 'waiting' state and an alarm wakes it up.
    MAX_INLINE_WAIT_MS: 90000,
    JOB_STALE_DISCOVERY_MS: 6 * 60 * 60 * 1000,
    MAX_AUTO_RESUMES: 40,
    LEETCODE_REQUEST_TIMEOUT_MS: 30000
  };

  LGS.CONST = CONSTS;
})(typeof self !== 'undefined' ? self : window);
