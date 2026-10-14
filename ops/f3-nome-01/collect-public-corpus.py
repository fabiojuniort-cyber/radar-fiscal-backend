"""Read official public title lists only. No auth, DB, production app or rule writes."""
import base64, datetime, gzip, hashlib, html, json, pathlib, re, time, urllib.parse, urllib.request

OUT = pathlib.Path('docs/f3-nome-02')
OUT.mkdir(parents=True, exist_ok=True)
rows, requests, errors, seen = [], [], [], set()

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
for days in range(10):
    date=end-datetime.timedelta(days=days)
    if date.weekday()>4: continue
    if sum(x['sourceCode']=='dou' for x in rows)>=1000: break
    for section in ['do1','do2','do3']:
        url='https://www.in.gov.br/leiturajornal?'+urllib.parse.urlencode({'data':date.strftime('%d-%m-%Y'),'secao':section})
        try:
            raw=get(url).decode('utf8')
            scripts=re.findall(r'<script[^>]*>(.*?)</script>',raw,re.S|re.I)
            candidates=[]
            for script in scripts:
                if 'jsonArray' not in script: continue
                try: candidates=json.loads(html.unescape(script.strip()))['jsonArray'];break
                except (ValueError,KeyError): continue
            if not candidates:
                pathlib.Path('/tmp/f3-dou-response.html').write_text(raw)
                raise ValueError('DOU jsonArray missing: '+raw[:80])
            for item in candidates:
                title=html.unescape(item.get('title','')).strip()
                slug=item.get('urlTitle') or item.get('url')
                if not title or not slug: continue
                add({'sourceCode':'dou','section':str(item.get('pubName',section)).upper(),
                     'title':title,'sourceActType':item.get('artType') or item.get('type'),
                     'officialUrl':slug if slug.startswith('https://') else 'https://www.in.gov.br/web/dou/-/'+slug,
                     'publishedOn':date.isoformat(),'evidenceComplete':False})
        except Exception as error: errors.append({'url':url,'error':str(error)})

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
        for item in data['publications']:
            add({'sourceCode':'doe-sp','section':'ATOS NORMATIVOS','title':html.unescape(item['title']).strip(),
                 'sourceActType':None,'officialUrl':'https://www.doe.sp.gov.br/'+item['slug'],
                 'publishedOn':date.isoformat(),'evidenceComplete':False})
    except Exception as error: errors.append({'url':url,'error':str(error)})

result={'basis':'Official public title-only lists; no complete bodies, company links or production archive',
        'requests':requests,'errors':errors,'publications':rows}
data=(json.dumps(result,ensure_ascii=False,indent=2)+'\n').encode()
(OUT/'public-corpus.json').write_bytes(data)
print('CORPUS_COUNTS='+json.dumps({s:sum(x['sourceCode']==s for x in rows) for s in ['dou','doe-sp']}),flush=True)
print('CORPUS_ERRORS='+json.dumps(errors),flush=True)
# Transfer the reproducible public corpus to the review workspace through CI logs.
encoded=base64.b64encode(gzip.compress(data,mtime=0)).decode()
for i in range(0,len(encoded),12000): print('F3_PUBLIC_CORPUS_B64='+encoded[i:i+12000],flush=True)
if len(rows)<2000 or not all(any(x['sourceCode']==s for x in rows) for s in ['dou','doe-sp']):
    raise SystemExit('INSUFFICIENT_OFFICIAL_CORPUS')
