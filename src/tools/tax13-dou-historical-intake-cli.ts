/**
 * TAX13-R8-02 operator-only LOCAL dry run.
 * This tool DOES NOT connect to any database, perform uploads or persist bytes.
 * Intended for testing a future controlled administrator file intake workflow.
 *
 * Example:
 * TAX13_DOU_INTAKE_STAGING_ROOT=/safe/staging \
 * TAX13_DOU_READ_ONLY_APPROVED=true npx tsx src/tools/tax13-dou-historical-intake-cli.ts \
 * --channel=MANUAL --kind=DOU_HISTORICAL_SCAN --mime=application/pdf \
 * --family="CONVÊNIO ICMS" --act=52/91 --date=1991-09-30 \
 * --section=DO1 --file=/safe/staging/scan.pdf
 */
import {lstat,readFile,realpath} from 'node:fs/promises';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {
 preflightHistoricalDouIntake,type HistoricalDouIntakeInput
} from '../modules/taxonomy/legal-scope/dou-historical-intake.js';

const args=new Map<string,string>();
const allowed=new Set(['channel','kind','mime','family','act','date','section',
 'page','source-url','file','text-file']);
for(const arg of process.argv.slice(2)){
 const match=/^--([a-z-]+)=(.+)$/s.exec(arg);
 if(!match||!allowed.has(match[1]!)||args.has(match[1]!))
  throw new Error('TAX13_HISTORICAL_READ_ONLY_ARGS_INVALID');
 args.set(match[1]!,match[2]!);
}
if(process.env.NODE_ENV==='production'||
 process.env.TAX13_DOU_READ_ONLY_APPROVED!=='true')
 throw new Error('TAX13_HISTORICAL_DRY_RUN_APPROVAL_REQUIRED');
function requireArg(k:string):string{
 const v=args.get(k);
 if(!v)throw new Error('TAX13_HISTORICAL_REQUIRED_'+k.toUpperCase().replaceAll('-','_'));
 return v;
}
const stagingRoot=process.env.TAX13_DOU_INTAKE_STAGING_ROOT;
async function boundedLocalFile(userPath:string,limit:number):Promise<Uint8Array>{
 if(!stagingRoot||!isAbsolute(stagingRoot)||!isAbsolute(userPath))
  throw new Error('TAX13_HISTORICAL_ABSOLUTE_STAGING_ROOT_REQUIRED');
 const root=await realpath(resolve(stagingRoot));
 const candidate=await realpath(userPath);
 const rel=relative(root,candidate);
 if(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel))
  throw new Error('TAX13_HISTORICAL_STAGING_BOUNDARY_VIOLATION');
 const stats=await lstat(userPath);
 if(!stats.isFile()||stats.isSymbolicLink()||stats.size<1||stats.size>limit)
  throw new Error('TAX13_HISTORICAL_FILE_NOT_ALLOWED');
 // File is intentionally read into a bounded transient buffer, never persisted.
 const bytes=await readFile(candidate);
 if(bytes.byteLength<1||bytes.byteLength>limit)
  throw new Error('TAX13_HISTORICAL_FILE_CHANGED_DURING_READ');
 return bytes;
}
const documentFile=args.get('file');
const textFile=args.get('text-file');
const sourceUrl=args.get('source-url');
if(!documentFile&&!textFile&&!sourceUrl)
 throw new Error('TAX13_HISTORICAL_MATERIAL_REQUIRED');
const documentBytes=documentFile?await boundedLocalFile(documentFile,16*1024*1024):undefined;
const textBytes=textFile?await boundedLocalFile(textFile,1*1024*1024):undefined;
const transcription=textBytes?new TextDecoder('utf-8',{fatal:true}).decode(textBytes):undefined;
const pageArg=args.get('page');
if(pageArg&&!/^\d+$/.test(pageArg))throw new Error('TAX13_HISTORICAL_PAGE_INVALID');
const input:HistoricalDouIntakeInput={
 acquisitionChannel:requireArg('channel') as HistoricalDouIntakeInput['acquisitionChannel'],
 materialKind:requireArg('kind') as HistoricalDouIntakeInput['materialKind'],
 mediaType:requireArg('mime') as HistoricalDouIntakeInput['mediaType'],
 actFamily:requireArg('family') as HistoricalDouIntakeInput['actFamily'],
 actNumber:requireArg('act'),douPublishedOn:requireArg('date'),
 section:requireArg('section') as HistoricalDouIntakeInput['section'],
 ...(pageArg?{page:Number(pageArg)}:{}),
 ...(sourceUrl?{sourceUrl}:{}),
 ...(documentBytes?{fileBytes:documentBytes,originalFilename:documentFile!.split(/[\\/]/).at(-1) ?? 'staged-document'}:{}),
 ...(transcription?{transcription}:{})
};
const result=preflightHistoricalDouIntake(input);
process.stdout.write(JSON.stringify(result)+'\n');
if(result.status!=='HISTORICAL_SOURCE_CANDIDATE')process.exitCode=2;
