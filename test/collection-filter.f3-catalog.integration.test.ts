import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';

test('F3 physical policy: surviving DOU/DOE-SP acts ignore legacy hidden classification across catalog surfaces', async (t) => {
  assert.ok(process.env.DATABASE_ADMIN_URL);
  const admin = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL, max: 1 });
  const app = await buildApp();
  const marker = `fiscala${randomUUID().replace(/[^a-f]/g, '').slice(0, 14)}`;
  const password = 'F3-Catalog-Test-2026!Safe';
  const email = `${marker}@example.test`;
  const publicationIds: string[] = [];
  const otherCode = `${marker}-other`;
  const unknownType = `Tipo sem regra ${marker}`;
  try {
    await app.ready();
    for (const code of ['dou', 'doe-sp', otherCode]) {
      await admin.query(`INSERT INTO sources
        (code,name,jurisdiction_level,uf,base_url,connector_key,is_active)
        VALUES ($1,$1,CASE WHEN $1='doe-sp' THEN 'STATE' ELSE 'FEDERAL' END,
          CASE WHEN $1='doe-sp' THEN 'SP' ELSE NULL END,
          'https://example.invalid/'||$1,$1,false) ON CONFLICT DO NOTHING`, [code]);
    }
    const sourceRows = await admin.query<{ id: string; code: string }>(
      'SELECT id,code FROM sources WHERE code=ANY($1::text[])', [['dou','doe-sp',otherCode]],
    );
    const sources = Object.fromEntries(sourceRows.rows.map((r) => [r.code, r.id]));
    async function seed(label: string, type: string, origins: string[]): Promise<string> {
      const id = randomUUID();
      publicationIds.push(id);
      const hash = createHash('sha256').update(id).digest('hex');
      await admin.query(`INSERT INTO publications
        (id,identity_hash,identity_strength,identity_basis,jurisdiction_level,uf,act_type,title,published_on)
        VALUES ($1,$2,'STRONG','{}','FEDERAL',NULL,$3,$4,current_date)`,
      [id,hash,type,`${type} ${label} ${marker}`]);
      await admin.query(`INSERT INTO publication_versions (publication_id,version_no,content_hash,content_text)
        VALUES ($1,1,$2,$3)`, [id,hash,`Conteudo ${marker} ${label}`]);
      for (const code of origins) {
        await admin.query(`INSERT INTO publication_origins (publication_id,source_id,external_id,official_url)
          VALUES ($1,$2,$3,$4)`, [id,sources[code],id,`https://example.invalid/${code}/${id}`]);
      }
      return id;
    }
    const dou = await seed('dou', 'Comunicado DGFIN', ['dou']);
    const doe = await seed('doe', 'Portaria do Coordenador Geral', ['doe-sp']);
    const protectedMultipleOrigins = await seed('protected', 'Comunicado DGFIN', ['dou',otherCode]);
    const otherHidden = await seed('legacy', 'COMISSAO DE ANALISE DE PROJETOS', [otherCode]);
    const unmatched = await seed('unmatched', unknownType, ['dou']);
    const visible = [dou,doe,protectedMultipleOrigins,unmatched].sort();
    const stored = await admin.query<{ id: string; is_hidden: boolean }>(
      'SELECT id,is_hidden FROM publications WHERE id=ANY($1::uuid[])', [publicationIds],
    );
    assert.equal(stored.rows.filter((r) => r.is_hidden).length, 4,
      'fixtures must exercise the generated legacy flag, without changing it');
    const register = await app.inject({method:'POST',url:'/auth/register',payload:{
      name:'F3 Catalog Reader',email,password,confirmPassword:password,acceptedTerms:true,
    }});
    assert.equal(register.statusCode,201,register.body);
    const login = await app.inject({method:'POST',url:'/auth/login',payload:{email,password}});
    assert.equal(login.statusCode,200,login.body);
    const headers = {authorization:`Bearer ${login.json<{accessToken:string}>().accessToken}`};
    async function archive(query: string) {
      const response = await app.inject({method:'GET',url:`/api/v2/archive?limit=50&${query}`,headers});
      assert.equal(response.statusCode,200,response.body);
      return response.json<{totalItems:number;items:Array<{id:string}>}>();
    }
    await t.test('browse/search/type/source lists and exact totals preserve survivors', async () => {
      const search = await archive(`q=${marker}`);
      assert.deepEqual(search.items.map((r) => r.id).sort(),visible);
      assert.equal(search.totalItems,4);
      assert.ok(!search.items.some((r) => r.id===otherHidden));
      for (const [source,expected] of [
        ['dou',[dou,protectedMultipleOrigins,unmatched]],
        ['doe-sp',[doe]],
        [otherCode,[protectedMultipleOrigins]],
      ] as const) {
        const result = await archive(`q=${marker}&source=${source}`);
        assert.deepEqual(result.items.map((r) => r.id).sort(),[...expected].sort());
        assert.equal(result.totalItems,expected.length);
      }
      const type = await archive(`q=${marker}&actType=${encodeURIComponent('Comunicado DGFIN')}`);
      assert.deepEqual(type.items.map((r) => r.id).sort(),[dou,protectedMultipleOrigins].sort());
      assert.equal(type.totalItems,2);
      const full = await archive(`q=${marker}&scope=full`);
      assert.deepEqual(full.items.map((r) => r.id).sort(),visible);
    });
    await t.test('detail exposes surviving F3 acts', async () => {
      for (const id of visible) {
        const response=await app.inject({method:'GET',url:`/api/v1/publications/${id}`,headers});
        assert.equal(response.statusCode,200,response.body);
        assert.equal(response.json<{publication:{id:string}}>().publication.id,id);
      }
    });
    await t.test('navigation facets include F3 kept and unmatched types but keep legacy exclusion elsewhere', async () => {
      const response=await app.inject({method:'GET',url:'/api/v2/archive/facets',headers});
      assert.equal(response.statusCode,200,response.body);
      const facets=response.json<{actTypes:string[];sources:Array<{code:string}>}>();
      for (const type of ['Comunicado DGFIN','Portaria do Coordenador Geral',unknownType]) {
        assert.ok(facets.actTypes.includes(type),`Missing facet ${type}`);
      }
      assert.ok(!facets.actTypes.includes('COMISSAO DE ANALISE DE PROJETOS'));
      for (const code of ['dou','doe-sp',otherCode]) assert.ok(facets.sources.some((r) => r.code===code));
      const navigation=await app.inject({method:'GET',
        url:`/api/v2/archive/navigation?groupBy=actType&source=${otherCode}`,headers});
      assert.equal(navigation.statusCode,200,navigation.body);
      assert.deepEqual(navigation.json<{items:unknown[]}>().items,
        [{value:'Comunicado DGFIN',label:'Comunicado DGFIN',count:1}]);
    });
    await t.test('public v2 stats/source counts agree with the catalog physical survivors', async () => {
      const stats=await app.inject({method:'GET',url:'/public/v2/stats'});
      assert.equal(stats.statusCode,200,stats.body);
      // The administrator bypasses RLS; account for the independent legal-scope
      // suppression that still applies to catalog readers and public statistics.
      const expected=await admin.query<{count:number}>(`SELECT count(*)::int AS count FROM publications p
        WHERE public.publication_scope_is_in_scope(p.id)
          AND (NOT p.is_hidden OR EXISTS (SELECT 1 FROM publication_origins po JOIN sources s ON s.id=po.source_id
            WHERE po.publication_id=p.id AND lower(s.code) IN ('dou','doe-sp')))`);
      assert.equal(stats.json<{totalPublications:number}>().totalPublications,expected.rows[0]!.count);
      const response=await app.inject({method:'GET',url:'/public/v2/sources'});
      assert.equal(response.statusCode,200,response.body);
      const counts=response.json<{items:Array<{code:string;totalPublications:number}>}>().items;
      assert.equal(counts.find((r) => r.code===otherCode)?.totalPublications,1);
    });
    await t.test('public v1 metadata API also exposes surviving F3 publications', async () => {
      for (const [source,expected] of [['dou',[dou,protectedMultipleOrigins,unmatched]],['doe-sp',[doe]]] as const) {
        const response=await app.inject({method:'GET',url:`/public/v1/publications?source=${source}&limit=20`});
        assert.equal(response.statusCode,200,response.body);
        const items=response.json<{items:Array<{id:string}>}>().items;
        for (const id of expected) assert.ok(items.some((r) => r.id===id),`Missing public publication ${id}`);
      }
    });
    const after=await admin.query<{id:string;is_hidden:boolean}>(
      'SELECT id,is_hidden FROM publications WHERE id=ANY($1::uuid[]) ORDER BY id',[publicationIds]);
    assert.deepEqual(after.rows,[...stored.rows].sort((a,b) => a.id.localeCompare(b.id)),
      'display requests do not mutate publications or the legacy generated flag');
  } finally {
    await app.close();
    await admin.query('DELETE FROM publication_versions WHERE publication_id=ANY($1::uuid[])',[publicationIds]);
    await admin.query('DELETE FROM publications WHERE id=ANY($1::uuid[])',[publicationIds]);
    await admin.query('DELETE FROM sources WHERE code=$1',[otherCode]);
    await admin.end();
  }
});
