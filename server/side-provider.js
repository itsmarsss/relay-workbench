import { runProcess } from './process.js';
export const githubReadTool = {
  name: 'github_read',
  description:
    'Read GitHub issues, pull requests, comments, reviews, diffs, checks, search results, REST GET endpoints or GraphQL queries using the host gh authentication. No writes, shell, auth changes or arbitrary CLI arguments. Use explicit OWNER/REPO and number from the linked issue; GitHub is not a substitute for another PR provider. REST and GraphQL return one bounded page; request additional pages explicitly.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      repositoryId: { type: 'string' },
      operation: {
        enum: [
          'issue',
          'pull_request',
          'diff',
          'checks',
          'search_issues',
          'search_prs',
          'api_get',
          'graphql',
        ],
      },
      repository: {
        type: 'string',
        description: 'OWNER/REPO, optional when a prepared GitHub worktree supplies it',
      },
      number: { type: 'integer', minimum: 1 },
      query: { type: 'string' },
      endpoint: { type: 'string' },
      variables: { type: 'object', additionalProperties: true },
    },
    required: ['repositoryId', 'operation'],
  },
};
function text(value, max = 16000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw Error('Invalid provider read argument');
  return value;
}
export function githubInvocation(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !Object.hasOwn(githubReadTool.inputSchema.properties, key))
  )
    throw Error('Unsupported GitHub read arguments');
  const repository = raw.repository === undefined ? [] : ['--repo', text(raw.repository, 300)];
  if (raw.repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw.repository))
    throw Error('Repository must be OWNER/REPO');
  const fields = 'number,title,body,url,state,author,comments,labels,assignees,createdAt,updatedAt';
  let args, input;
  if (['issue', 'pull_request', 'diff', 'checks'].includes(raw.operation)) {
    if (!Number.isSafeInteger(raw.number) || raw.number < 1)
      throw Error('Specify a positive issue or pull request number');
    const number = String(raw.number);
    if (raw.operation === 'issue')
      args = ['issue', 'view', number, ...repository, '--json', fields];
    else if (raw.operation === 'pull_request')
      args = [
        'pr',
        'view',
        number,
        ...repository,
        '--json',
        fields +
          ',reviews,reviewDecision,statusCheckRollup,baseRefName,headRefName,mergeCommit,mergedAt,isDraft',
      ];
    else if (raw.operation === 'diff')
      args = ['pr', 'diff', number, ...repository, '--color', 'never'];
    else
      args = ['pr', 'checks', number, ...repository, '--json', 'name,state,bucket,link,workflow'];
  } else if (['search_issues', 'search_prs'].includes(raw.operation)) {
    args = [
      'search',
      raw.operation === 'search_prs' ? 'prs' : 'issues',
      ...repository,
      '--limit',
      '30',
      '--json',
      'number,title,url,state,repository,author,updatedAt',
      '--',
      text(raw.query, 2000),
    ];
  } else if (raw.operation === 'api_get') {
    const endpoint = text(raw.endpoint, 4000).replace(/^\//, '');
    const path = decodeURIComponent(endpoint.split('?')[0]);
    if (
      !/^[A-Za-z0-9_]/.test(endpoint) ||
      endpoint.includes('://') ||
      /[\r\n#]/.test(endpoint) ||
      path.split('/').some((p) => p === '..' || p === '.') ||
      path.split('/')[0].toLowerCase() === 'graphql'
    )
      throw Error('Use a relative REST endpoint; use graphql for query operations');
    args = ['api', '--method', 'GET', endpoint];
  } else if (raw.operation === 'graphql') {
    const query = text(raw.query);
    // Strip literals/comments before checking operation names. Mutation operations
    // are never exposed, including additional operations in the same document.
    const document = query
      .replace(/"""(?:\\.|(?!""")[\s\S])*"""|"(?:\\.|[^"\\])*"|#[^\r\n]*/g, ' ')
      .trim();
    if (!/^(?:query\b|\{)/.test(document) || /\b(?:mutation|subscription)\b/.test(document))
      throw Error('Only GraphQL query operations are available');
    if (
      raw.variables !== undefined &&
      (!raw.variables || typeof raw.variables !== 'object' || Array.isArray(raw.variables))
    )
      throw Error('GraphQL variables must be an object');
    input = JSON.stringify({ query, variables: raw.variables ?? {} });
    if (input.length > 32000) throw Error('GraphQL request is too large');
    args = ['api', 'graphql', '--input', '-'];
  } else throw Error('Unsupported GitHub read operation');
  return { args, input };
}
export async function readGithub(raw, cwd, run = runProcess) {
  const invocation = githubInvocation(raw);
  const result = await run('gh', invocation.args, {
    cwd,
    input: invocation.input,
    timeout: 30000,
    maxBytes: 1024 * 1024,
    env: { GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' },
  });
  let checkState = false;
  if (raw.operation === 'checks' && [1, 8].includes(result.code)) {
    try {
      checkState = Array.isArray(JSON.parse(result.stdout));
    } catch {}
  }
  if (result.code !== 0 && !checkState)
    throw Error((result.stderr || result.stdout || 'GitHub read failed').slice(0, 3000));
  return {
    provider: 'github',
    observedAt: new Date().toISOString(),
    operation: raw.operation,
    exitCode: result.code,
    output: result.stdout,
  };
}
