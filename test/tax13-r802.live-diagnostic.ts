/**
 * TAX13-R8-02 public-source network diagnostic on an automatically discarded
 * GitHub Actions runner. NEVER generates an official receipt, proof or CURRENT.
 * No database credentials; no persistent raw HTTP payloads or uploads.
 */
import {captureOfficialConfazHttps} from '../src/modules/taxonomy/legal-scope/confaz-official-capture.js';

if (process.env.GITHUB_ACTIONS!=='true') {
  throw new Error('TAX13_R802_DIAGNOSTIC_CI_ONLY');
}
const urls=[
  'https://www.confaz.fazenda.gov.br/legislacao/convenios/1991/CV052_91',
  'https://www.confaz.fazenda.gov.br/legislacao/convenios/1997/CV100_97',
];
let failed=false;
for(const url of urls) {
  try{
    const result=await captureOfficialConfazHttps(url,'r802-diagnostic-ci');
    // Report only bounded, non-sensitive transport metadata. Never print raw HTML.
    console.log('R802_NETWORK_DIAGNOSTIC='+JSON.stringify({
      classification:'DIAGNOSTIC_ONLY_NOT_ADMISSIBLE_LEGAL_PROOF',
      source:url, finalUrl:result.finalUrl,
      redirectCount:result.redirectChain.length-1,
      bytes:result.rawBytes.length,sha256:result.rawSha256,
      remoteIpv4:result.remoteIpv4,
      tlsPeerCertificateSha256:result.tlsPeerCertificateSha256,
      collectedAt:result.collectedAt
    }));
  }catch(error){
    failed=true;
    console.error('R802_NETWORK_DIAGNOSTIC_ERROR='+JSON.stringify({
      classification:'UNAVAILABLE_NOT_LEGAL_PROOF',
      source:url,error:error instanceof Error?error.message:String(error)
    }));
  }
}
if(failed)process.exitCode=1;
