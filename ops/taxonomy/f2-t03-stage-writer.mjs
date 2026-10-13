// F2-T03 lossless staging writer (isolated PostgreSQL 18 only).
// Production writes are disabled until backup restoration and explicit approval.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { parseApprovedWorkbook, planImport } from './f2-xlsx-dry-run.mjs';

const { Pool } = pg;
const hash = value => createHash('sha256').update(value).digest('hex');
const reject = message => { throw new Error('F2_STAGE_BLOCK: ' + message); };
