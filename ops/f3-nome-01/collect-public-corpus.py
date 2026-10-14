"""Read official public title lists only. No auth, DB, production app or rule writes."""
import base64, datetime, gzip, hashlib, html, json, pathlib, re, time, urllib.parse, urllib.request, sys

OUT = pathlib.Path('docs/f3-nome-02')
OUT.mkdir(parents=True, exist_ok=True)
rows, requests, errors, seen = [], [], [], set()
if '--refresh' not in sys.argv and (OUT/'public-corpus.json').exists():
    data=json.loads((OUT/'public-corpus.json').read_text())
    pubs=data['publications']
    assert len(pubs)>=2000 and all(any(p['sourceCode']==s for p in pubs) for s in ['dou','doe-sp'])
    assert len({(p['sourceCode'],p['officialUrl']) for p in pubs})==len(pubs)
    print('OFFLINE_OFFICIAL_CORPUS_VERIFIED='+str(len(pubs)))
    sys.exit(0)

def get(url):
    time.sleep(.4)
    with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent':'Trifar os F3-NOME-02 public impact audit'.replace('Trifar os','Trifaros')}), timeout=35) as response:
        data = response.read(16 * 1024 * 1024 + 1)
        if len(data) > 16 * 1024 * 1024: raise ValueError('oversized official response')
    requests.append({'url':url,'retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
                     'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    return data

def add(row):
    identity=(row['sourceCode'],row['officialUrl'])
    if identity not in seen:
        seen.add(identity); rows.append(row)

end=datetime.date(2026,10,14)
# A normal browser read of the official journal is supported when the HTTP client is denied.
# The file must contain only rows extracted from that official document, with URL/time provenance.
if '--dou-file' in sys.argv:
    path=pathlib.Path(sys.argv[sys.argv.index('--dou-file')+1]);data=path.read_bytes()
    evidence=json.loads(data)
    if urllib.parse.urlparse(evidence['url']).hostname!='www.in.gov.br': raise ValueError('not official DOU')
    requests.append({'url':evidence['url'],'retrievedAt':evidence['retrievedAt'],'method':'Official browser DOM params extraction',
                     'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
    for row in evidence['publications']: add(row)
else:
    raise SystemExit('Provide --refresh --dou-file <official-browser-title-export>')

api='https://do-api-web-search.doe.sp.gov.br/'
journals=json.loads(get(api+'v2/journals'))['items']
journal=next(x for x in journals if x['name']=='Executivo')
sections=json.loads(get(api+'v2/sections?JournalId='+journal['id']))['items']
section=next(x for x in sections if x['name']=='Atos Normativos')
for days in range(10):
    date=end-datetime.timedelta(days=days)
    if date.weekday()>4: continue
    if sum(x['sourceCode']=='doe-sp' for x in rows)>=1500: break
    url=api+'v2/summary/list?'+urllib.parse.urlencode({'Date':date.isoformat(),'JournalId':journal['id'],'SectionId':section['id']})
    try:
        data=json.loads(get(url))
        catalogue=json.loads(get(url.replace('/summary/list?','/summary/filters?')))
        types={t['id']:t['name'] for t in catalogue['publicationTypes']}
        for item in data['publications']:
            add({'sourceCode':'doe-sp','section':'ATOS NORMATIVOS','title':html.unescape(item['title']).strip(),
                 'sourceActType':types.get(item.get('publicationTypeId')),'officialUrl':'https://www.doe.sp.gov.br/'+item['slug'],
                 'publishedOn':date.isoformat(),'evidenceComplete':False})
    except Exception as error: errors.append({'url':url,'error':str(error)})

result={'basis':'Official public title-only lists; no complete bodies, company links or production archive',
        'requests':requests,'errors':errors,'publications':rows}
data=(json.dumps(result,ensure_ascii=False,indent=2)+'\n').encode()
(OUT/'public-corpus.json').write_bytes(data)
print('CORPUS_COUNTS='+json.dumps({s:sum(x['sourceCode']==s for x in rows) for s in ['dou','doe-sp']}),flush=True)
print('CORPUS_ERRORS='+json.dumps(errors),flush=True)
encoded=base64.b64encode(gzip.compress(data,mtime=0)).decode()
for i in range(0,len(encoded),12000): print('F3_PUBLIC_CORPUS_B64='+encoded[i:i+12000],flush=True)
if len(rows)<2000 or not all(any(x['sourceCode']==s for x in rows) for s in ['dou','doe-sp']):
    raise SystemExit('INSUFFICIENT_OFFICIAL_CORPUS')
