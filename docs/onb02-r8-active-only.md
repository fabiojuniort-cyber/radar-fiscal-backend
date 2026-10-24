# ONB-02 R8 — empresa ativa ou excluída

A empresa permanece ativa até exclusão física pela função 073, chamada por
company-purge.service.ts com contexto de usuário/tenant, guardas e timeouts.
Não existe operação de desativação de empresa. A exclusão individual de
estabelecimento mantém seu contrato próprio; não é desativação de empresa.

A migration 076 adiciona companies_active_only, CHECK (is_active IS TRUE),
validada na instalação e aplicada a qualquer INSERT/UPDATE, inclusive SQL direto.
Não atualiza nem purga legado: se houver inativas, a migration falha. A limpeza
produtiva é operação separada autorizada na Issue #118, anterior ao deploy desta
migration. Este PR não autoriza merge, deploy, migration ou purga produtiva.

O campo is_active/isActive permanece compatível com clientes antigos, sempre true
para empresas existentes após a migration. Os cadastros automático e manual
mantêm o 409 company_inactive_requires_deletion como defesa durante a transição;
o frontend orienta contato com suporte, sem reativação ou exclusão automática.

O teste PG18 do grafo verifica rejeição de INSERT/UPDATE inativo, manutenção
da empresa ativa e seu perfil durante purga de outra empresa, isolamento por
tenant e exclusão/recriação com novo identificador. Fixtures históricas de
auditoria podem conter is_active=false: não são estados atuais da tabela.
