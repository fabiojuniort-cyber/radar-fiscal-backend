/**
 * TAX-11 — initial curation proposal applied only when the first curated
 * DRAFT is created from a release without curated settings (v1.1.0).
 *
 * Every value here is a SUGGESTION for the curator to review in the admin
 * tables before publishing. Official codes are stored as digits only and
 * are intentionally coarse (chapter/position) where the product is broad.
 * Nothing in this file is applied to a published release.
 */

export const SEED_NOTE = 'Sugestão TAX-11 — conferir antes de publicar.';

export interface SeedGroup {
  code: string;
  label: string;
  /** Overrides the dimension section on the legislation page. */
  detailSection?: string;
  officialCodes?: string[];
  /** Sector concept suffixes (sector.<suffix>) this product group serves. */
  segments?: string[];
  /** Concept suffixes (<dimension>.<suffix>) in display order. */
  members: string[];
}

export interface DimensionSeed {
  groups: SeedGroup[];
}

/** Concept suffix -> official codes (digits). */
export type SeedCodes = Record<string, string[]>;

export const PRODUCT_SEED: DimensionSeed = {
  groups: [
    { code: 'graos_oleaginosas', label: 'Grãos e oleaginosas', segments: ['agribusiness', 'rural_production'], members: ['grains', 'soy', 'corn', 'wheat', 'rice', 'beans', 'sorghum'] },
    { code: 'sementes_mudas', label: 'Sementes e mudas', segments: ['agribusiness', 'rural_production'], members: ['seeds', 'soybean_seed', 'corn_seed', 'seedlings'] },
    { code: 'fertilizantes', label: 'Fertilizantes e corretivos', officialCodes: ['31'], segments: ['agribusiness', 'chemical_industry'], members: ['fertilizers', 'mineral_fertilizer', 'organic_fertilizer', 'urea', 'potash', 'phosphate_rock', 'agricultural_lime'] },
    { code: 'defensivos', label: 'Defensivos e adjuvantes', officialCodes: ['3808'], segments: ['agribusiness', 'chemical_industry'], members: ['crop_protection', 'herbicide', 'insecticide', 'fungicide', 'pesticide_active_ingredient'] },
    { code: 'culturas', label: 'Culturas agrícolas', segments: ['agribusiness', 'rural_production'], members: ['coffee', 'cocoa', 'cotton', 'sugarcane', 'fruit', 'vegetables'] },
    { code: 'pecuaria', label: 'Pecuária', segments: ['agribusiness', 'rural_production'], members: ['live_cattle', 'live_swine', 'live_poultry', 'eggs'] },
    { code: 'nutricao_animal', label: 'Nutrição animal', segments: ['agribusiness'], members: ['animal_feed', 'feed_supplement', 'fishmeal'] },
    { code: 'maquinas_agricolas', label: 'Máquinas agrícolas', segments: ['agribusiness'], members: ['tractors', 'harvesters', 'irrigation_equipment', 'agricultural_drones'] },
    { code: 'agroindustria', label: 'Agroindústria', segments: ['agribusiness', 'food_industry'], members: ['soybean_meal', 'soybean_oil'] },
    { code: 'carnes', label: 'Carnes', officialCodes: ['02'], segments: ['meatpacking', 'slaughterhouse', 'meat_products', 'meat_distribution'], members: ['meat', 'beef', 'pork', 'poultry_meat', 'processed_meat'] },
    { code: 'pescados', label: 'Pescados', officialCodes: ['03'], segments: ['food_industry'], members: ['fish'] },
    { code: 'laticinios', label: 'Laticínios', segments: ['food_industry'], members: ['dairy', 'milk', 'cheese'] },
    { code: 'panificacao_massas', label: 'Panificação e massas', segments: ['food_industry'], members: ['bread', 'pasta', 'wheat_flour'] },
    { code: 'acucar_cafe_cacau', label: 'Açúcar, café e cacau', segments: ['food_industry'], members: ['sugar', 'roasted_coffee', 'coffee_extract', 'chocolate'] },
    { code: 'oleos_comestiveis', label: 'Óleos comestíveis', officialCodes: ['15'], segments: ['food_industry'], members: ['edible_oils'] },
    { code: 'outros_alimentos', label: 'Outros alimentos', segments: ['food_industry'], members: ['salt'] },
    { code: 'bebidas_alcoolicas', label: 'Bebidas alcoólicas', segments: ['beverages'], members: ['beer', 'wine', 'spirits'] },
    { code: 'bebidas_nao_alcoolicas', label: 'Bebidas não alcoólicas', segments: ['beverages'], members: ['soft_drinks', 'sweetened_beverages', 'bottled_water'] },
    { code: 'petroleo_derivados', label: 'Petróleo e derivados', officialCodes: ['2709', '2710'], segments: ['fuels', 'oil_gas'], members: ['fuels', 'crude_oil', 'diesel', 'gasoline', 'aviation_gasoline', 'aviation_kerosene', 'fuel_oil', 'marine_fuel', 'naphtha', 'lubricants'] },
    { code: 'gas', label: 'Gás', officialCodes: ['2711'], segments: ['fuels', 'oil_gas'], members: ['natural_gas', 'lng', 'lpg'] },
    { code: 'biocombustiveis', label: 'Biocombustíveis', segments: ['fuels', 'energy'], members: ['ethanol_fuel', 'ethanol_industrial', 'biodiesel', 'biogas', 'biomethane'] },
    { code: 'outros_energeticos', label: 'Outros energéticos', segments: ['fuels', 'energy'], members: ['coal', 'wood_charcoal', 'hydrogen'] },
    { code: 'energia_eletrica', label: 'Energia elétrica e equipamentos', segments: ['energy'], members: ['electricity', 'solar_panels', 'wind_turbines', 'electric_generators', 'power_transformers', 'electric_motors'] },
    { code: 'baterias', label: 'Baterias', officialCodes: ['8507'], segments: ['energy', 'automotive_industry'], members: ['batteries', 'lithium_batteries'] },
    { code: 'minerios', label: 'Minérios', segments: ['mining'], members: ['iron_ore', 'copper_ore', 'bauxite', 'lithium_ore', 'graphite'] },
    { code: 'metais', label: 'Metais', segments: ['metallurgy'], members: ['steel', 'aluminum', 'copper'] },
    { code: 'metais_preciosos', label: 'Metais e pedras preciosas', segments: ['mining'], members: ['gold', 'silver', 'precious_stones', 'jewelry'] },
    { code: 'quimicos_basicos', label: 'Químicos básicos', segments: ['chemical_industry'], members: ['chemicals', 'ammonia', 'sulfuric_acid', 'caustic_soda', 'industrial_gases', 'industrial_reagents'] },
    { code: 'resinas_plasticos', label: 'Resinas e plásticos', segments: ['chemical_industry'], members: ['plastic_resins', 'petroleum_resins'] },
    { code: 'higiene_limpeza', label: 'Higiene, limpeza e cosméticos', segments: ['chemical_industry'], members: ['cosmetics', 'cleaning_agents', 'diapers'] },
    { code: 'cimento_concreto', label: 'Cimento e concreto', segments: ['construction'], members: ['cement', 'ready_mix_concrete'] },
    { code: 'agregados', label: 'Agregados', segments: ['construction', 'mining'], members: ['sand', 'gravel', 'limestone'] },
    { code: 'ceramica_vidro', label: 'Cerâmica e vidro', segments: ['construction'], members: ['clay_bricks', 'ceramic_tiles', 'glass'] },
    { code: 'madeira', label: 'Madeira', officialCodes: ['44'], segments: ['construction'], members: ['timber'] },
    { code: 'maquinas_industriais', label: 'Máquinas industriais', segments: ['manufacturing'], members: ['machines', 'machine_tools', 'industrial_robots', 'construction_equipment'] },
    { code: 'veiculos', label: 'Veículos', officialCodes: ['87'], segments: ['automotive_industry'], members: ['vehicles', 'passenger_cars', 'trucks', 'buses', 'motorcycles', 'electric_vehicles'] },
    { code: 'autopecas_pneus', label: 'Autopeças e pneus', segments: ['automotive_industry'], members: ['auto_parts', 'tires'] },
    { code: 'aeronaves_embarcacoes', label: 'Aeronaves, embarcações e ferroviário', segments: ['aviation', 'maritime_ports', 'transport'], members: ['aircraft', 'vessels', 'rail_vehicles'] },
    { code: 'informatica', label: 'Informática', segments: ['software_saas'], members: ['computers', 'servers', 'software'] },
    { code: 'eletronicos', label: 'Eletrônicos', segments: ['telecom'], members: ['semiconductors', 'mobile_phones'] },
    { code: 'telecom', label: 'Telecomunicações', segments: ['telecom'], members: ['network_equipment', 'optical_fiber'] },
    { code: 'medicamentos', label: 'Medicamentos', segments: ['health', 'pharmaceutical_industry'], members: ['medicines', 'vaccines', 'blood_products', 'active_pharmaceutical_ingredients', 'diagnostic_reagents'] },
    { code: 'dispositivos_medicos', label: 'Dispositivos médicos', segments: ['health'], members: ['medical_devices', 'hospital_equipment', 'surgical_instruments', 'implants', 'prostheses', 'hearing_aids', 'wheelchairs', 'eyeglasses', 'medical_gloves', 'medical_oxygen', 'personal_protective_equipment'] },
    { code: 'celulose_papel', label: 'Celulose e papel', segments: ['pulp_paper'], members: ['wood_pulp', 'paper', 'cardboard'] },
    { code: 'embalagens', label: 'Embalagens', segments: ['pulp_paper', 'chemical_industry'], members: ['packaging', 'corrugated_boxes', 'plastic_packaging'] },
    { code: 'editorial', label: 'Editorial', segments: ['media_advertising'], members: ['books', 'newspapers'] },
    { code: 'fibras_fios', label: 'Fibras e fios', segments: ['textiles_apparel'], members: ['cotton_yarn', 'synthetic_yarn', 'wool'] },
    { code: 'tecidos', label: 'Tecidos', segments: ['textiles_apparel'], members: ['textile_fabrics', 'nonwoven_fabrics'] },
    { code: 'confeccao_calcados', label: 'Confecção e calçados', segments: ['textiles_apparel'], members: ['apparel', 'footwear'] },
    { code: 'couros', label: 'Couros', officialCodes: ['41'], segments: ['textiles_apparel', 'meatpacking'], members: ['animal_hides', 'finished_leather'] },
    { code: 'tabaco', label: 'Tabaco', officialCodes: ['24'], segments: ['tobacco'], members: ['tobacco_leaf', 'cigarettes', 'cigars'] },
    { code: 'armas_municoes', label: 'Armas e munições', officialCodes: ['93'], members: ['firearms', 'ammunition'] },
    { code: 'arte', label: 'Obras de arte', members: ['artworks'] },
  ],
};

/** NCM suggestions per product (digits; position/subposition level). */
export const PRODUCT_NCM_SEED: SeedCodes = {
  soy: ['1201'], corn: ['1005'], wheat: ['1001'], rice: ['1006'], beans: ['0713'], sorghum: ['1007'],
  soybean_seed: ['120110'], corn_seed: ['100510'], seedlings: ['0602'],
  organic_fertilizer: ['3101'], urea: ['310210'], potash: ['3104'], phosphate_rock: ['2510'],
  herbicide: ['380893'], insecticide: ['380891'], fungicide: ['380892'],
  coffee: ['0901'], cocoa: ['1801'], cotton: ['5201'], sugarcane: ['121293'], fruit: ['08'], vegetables: ['07'],
  live_cattle: ['0102'], live_swine: ['0103'], live_poultry: ['0105'], eggs: ['0407'],
  animal_feed: ['2309'], feed_supplement: ['2309'], fishmeal: ['230120'],
  tractors: ['8701'], harvesters: ['8433'], irrigation_equipment: ['8424'], agricultural_drones: ['8806'],
  soybean_meal: ['2304'], soybean_oil: ['1507'],
  beef: ['0201', '0202'], pork: ['0203'], poultry_meat: ['0207'], processed_meat: ['1601', '1602'],
  fish: ['03'], milk: ['0401'], cheese: ['0406'],
  bread: ['1905'], pasta: ['1902'], wheat_flour: ['1101'],
  sugar: ['1701'], roasted_coffee: ['0901'], coffee_extract: ['210111'], chocolate: ['1806'],
  salt: ['2501'], beer: ['2203'], wine: ['2204'], spirits: ['2208'],
  soft_drinks: ['220210'], sweetened_beverages: ['2202'], bottled_water: ['2201'],
  crude_oil: ['2709'], diesel: ['271019'], gasoline: ['271012'], aviation_gasoline: ['271012'],
  aviation_kerosene: ['271019'], fuel_oil: ['271019'], lubricants: ['271019'],
  natural_gas: ['271121'], lng: ['271111'], lpg: ['2711'],
  ethanol_fuel: ['2207'], ethanol_industrial: ['2207'], biodiesel: ['3826'],
  coal: ['2701'], wood_charcoal: ['4402'], hydrogen: ['280410'],
  solar_panels: ['854143'], wind_turbines: ['850231'], electric_generators: ['8502'],
  power_transformers: ['8504'], electric_motors: ['8501'], lithium_batteries: ['850760'],
  iron_ore: ['2601'], copper_ore: ['2603'], bauxite: ['2606'], graphite: ['2504', '3801'],
  steel: ['72'], aluminum: ['76'], copper: ['74'],
  gold: ['7108'], silver: ['7106'], precious_stones: ['7103'], jewelry: ['7113'],
  ammonia: ['2814'], sulfuric_acid: ['2807'], caustic_soda: ['2815'], industrial_reagents: ['3822'],
  plastic_resins: ['39'], petroleum_resins: ['3911'],
  cosmetics: ['33'], cleaning_agents: ['3402'], diapers: ['9619'],
  cement: ['2523'], ready_mix_concrete: ['382450'], sand: ['2505'], gravel: ['2517'], limestone: ['2521'],
  clay_bricks: ['6904'], ceramic_tiles: ['6907'], glass: ['70'], timber: ['44'],
  industrial_robots: ['842870'], construction_equipment: ['8429'],
  passenger_cars: ['8703'], trucks: ['8704'], buses: ['8702'], motorcycles: ['8711'], electric_vehicles: ['870380'],
  auto_parts: ['8708'], tires: ['4011'], aircraft: ['8802'], vessels: ['89'], rail_vehicles: ['86'],
  computers: ['8471'], servers: ['8471'], semiconductors: ['8541', '8542'], mobile_phones: ['851713'],
  network_equipment: ['851762'], optical_fiber: ['900110', '854470'],
  medicines: ['3003', '3004'], vaccines: ['300241'], blood_products: ['300212'], diagnostic_reagents: ['3822'],
  medical_devices: ['9018'], hospital_equipment: ['9018'], surgical_instruments: ['901890'],
  implants: ['9021'], prostheses: ['9021'], hearing_aids: ['902140'], wheelchairs: ['8713'],
  eyeglasses: ['9004'], medical_gloves: ['4015'], medical_oxygen: ['280440'],
  wood_pulp: ['47'], paper: ['48'], cardboard: ['48'], corrugated_boxes: ['481910'], plastic_packaging: ['3923'],
  books: ['4901'], newspapers: ['4902'],
  cotton_yarn: ['5205'], synthetic_yarn: ['5402'], wool: ['5101'], nonwoven_fabrics: ['5603'],
  apparel: ['61', '62'], footwear: ['64'], animal_hides: ['41'], finished_leather: ['41'],
  tobacco_leaf: ['2401'], cigarettes: ['240220'], cigars: ['240210'],
  firearms: ['93'], ammunition: ['9306'], artworks: ['9701'],
};

/** CNAE suggestions per segment (digits; division/group/class prefixes). */
export const SECTOR_CNAE_SEED: SeedCodes = {
  agribusiness: ['01', '02', '03'],
  rural_production: ['01'],
  mining: ['05', '07', '08'],
  oil_gas: ['06', '091'],
  food_industry: ['10'],
  beverages: ['11'],
  tobacco: ['12'],
  textiles_apparel: ['13', '14', '15'],
  pulp_paper: ['17'],
  fuels: ['19'],
  chemical_industry: ['20'],
  pharmaceutical_industry: ['21'],
  metallurgy: ['24'],
  automotive_industry: ['29'],
  energy: ['35'],
  sanitation: ['36', '37', '38'],
  construction: ['41', '42', '43'],
  wholesale: ['46'],
  retail: ['47'],
  transport: ['49', '50', '52', '53'],
  aviation: ['51'],
  maritime_ports: ['50', '5231'],
  tourism_hospitality: ['55', '79'],
  food_service: ['56'],
  media_advertising: ['59', '60', '73'],
  telecom: ['61'],
  software_saas: ['62', '63'],
  banking: ['64'],
  insurance: ['65'],
  health_plans: ['655'],
  real_estate: ['68'],
  professional_services: ['69', '70', '71', '74'],
  education: ['85'],
  health: ['86'],
  gaming_betting: ['92'],
  sports: ['931'],
  meatpacking: ['1011', '1012'],
  slaughterhouse: ['1011', '1012'],
  meat_products: ['1013'],
  meat_distribution: ['4634'],
};

export const THEME_SEED: DimensionSeed = {
  groups: [
    { code: 'beneficios', label: 'Benefícios fiscais', detailSection: 'Benefícios e tratamentos', members: ['tax_benefit', 'exemption', 'immunity', 'non_incidence', 'presumed_credit', 'rate_reduction', 'tax_base_reduction', 'tax_deferral', 'tax_suspension', 'national_basic_basket', 'personalized_refund', 'benefit_compensation_fund'] },
    { code: 'creditos', label: 'Créditos', members: ['input_credit', 'credit_appropriation', 'credit_maintenance', 'credit_reversal', 'non_cumulativity'] },
    { code: 'base_aliquota', label: 'Base e alíquota', members: ['tax_incidence', 'tax_base', 'tax_rate', 'additional_rate', 'rate_difference', 'transfer_pricing'] },
    { code: 'cobranca_pagamento', label: 'Cobrança e pagamento', members: ['main_obligation', 'assessment', 'assessed_tax_credit', 'assisted_assessment', 'payment', 'withholding', 'anticipation', 'tax_substitution', 'split_payment', 'installment_plan', 'offset', 'refund', 'reimbursement'] },
    { code: 'obrigacoes_contencioso', label: 'Obrigações, fiscalização e contencioso', members: ['ancillary_obligation', 'audit', 'fine', 'penalty', 'tax_consultation', 'tax_dispute', 'tax_settlement'] },
    { code: 'reforma', label: 'Reforma tributária', members: ['reform_transition'] },
  ],
};

export const TREATMENT_SEED: DimensionSeed = {
  groups: [
    { code: 'beneficios', label: 'Benefícios', members: ['exemption', 'zero_rate', 'rate_reduction', 'tax_base_reduction', 'presumed_credit', 'credit_maintenance', 'tax_deferral', 'tax_suspension'] },
    { code: 'cobranca_especial', label: 'Formas especiais de cobrança', members: ['anticipation', 'tax_substitution', 'monophase', 'credit_reversal'] },
  ],
};

export const TAX_SEED: DimensionSeed = {
  groups: [
    { code: 'consumo', label: 'Tributos sobre consumo', members: ['ibs', 'cbs', 'is', 'icms', 'ipi', 'iss', 'pis_pasep', 'cofins', 'pis_pasep_import', 'cofins_import'] },
    { code: 'renda', label: 'Renda e lucro', members: ['ir', 'irpj', 'irpf', 'csll'] },
    { code: 'folha_previdencia', label: 'Folha e previdência', members: ['social_security_contribution', 'payroll_employer_contribution', 'rat', 'cprb', 'third_party_contributions', 'salary_education', 'rpps_contribution', 'rural_commercialization_contribution'] },
    { code: 'comercio_exterior', label: 'Comércio exterior', members: ['ii', 'ie', 'afrmm'] },
    { code: 'patrimonio', label: 'Patrimônio', members: ['iptu', 'ipva', 'itr', 'itbi', 'itcmd', 'igf'] },
    { code: 'financeiras', label: 'Operações financeiras', members: ['iof'] },
    { code: 'outras_contribuicoes', label: 'Outras contribuições', members: ['cide', 'cide_fuels', 'cide_royalties', 'condecine', 'funttel', 'fust', 'cip', 'corporate_interest_contribution', 'state_primary_products_contribution'] },
    { code: 'outros', label: 'Outros', members: ['extraordinary_war_tax', 'residual_tax'] },
  ],
};

export const REGIME_SEED: DimensionSeed = {
  groups: [
    { code: 'apuracao_ir', label: 'Apuração do IRPJ/CSLL', members: ['actual_profit', 'presumed_profit', 'arbitrated_profit'] },
    { code: 'simples', label: 'Simples Nacional', members: ['simples_nacional', 'simei'] },
    { code: 'pis_cofins', label: 'PIS/Cofins', members: ['pis_cofins_non_cumulative', 'pis_cofins_cumulative'] },
    { code: 'ibs_cbs', label: 'IBS/CBS', members: ['regular', 'differentiated_ibs_cbs', 'specific_ibs_cbs', 'special'] },
    { code: 'aduaneiros', label: 'Aduaneiros e incentivos', members: ['drawback', 'recof', 'repetro', 'reidi', 'temporary_admission', 'customs_transit'] },
    { code: 'zonas', label: 'Zonas incentivadas', members: ['zfm', 'free_trade_areas'] },
  ],
};

export const DOCUMENT_SEED: DimensionSeed = {
  groups: [
    { code: 'mercadorias', label: 'Mercadorias', members: ['nfe', 'nfce', 'rural_producer_invoice'] },
    { code: 'transporte', label: 'Transporte', members: ['cte', 'cte_os', 'mdfe', 'bpe', 'gtve'] },
    { code: 'servicos', label: 'Serviços', members: ['nfse'] },
    { code: 'energia_comunicacao', label: 'Energia e comunicação', members: ['nf3e', 'nfcom'] },
    { code: 'outros', label: 'Outros', members: ['dere'] },
  ],
};

/** "Rótulo; modelo" labels from R6 split into label + official model. */
export const DOCUMENT_LABEL_FIXES: Record<string, { label: string; codes: string[] }> = {
  nfe: { label: 'NF-e', codes: ['55'] },
  nfce: { label: 'NFC-e', codes: ['65'] },
  cte: { label: 'CT-e', codes: ['57'] },
  cte_os: { label: 'CT-e OS', codes: ['67'] },
  mdfe: { label: 'MDF-e', codes: ['58'] },
  bpe: { label: 'BP-e', codes: ['63'] },
  gtve: { label: 'GTV-e', codes: ['64'] },
  nf3e: { label: 'NF3-e', codes: ['66'] },
  nfcom: { label: 'NFCom', codes: ['62'] },
  nfse: { label: 'NFS-e', codes: [] },
  dere: { label: 'DeRE', codes: [] },
  rural_producer_invoice: { label: 'Nota Fiscal de Produtor', codes: ['04'] },
};

export const OBLIGATION_SEED: DimensionSeed = {
  groups: [
    { code: 'sped', label: 'SPED', members: ['ecd', 'ecf', 'efd_icms_ipi', 'efd_contributions', 'efd_reinf'] },
    { code: 'federais', label: 'Federais (RFB)', members: ['dctfweb', 'dirbi', 'dirf', 'dimob', 'dmed', 'doi', 'efinanceira'] },
    { code: 'simples', label: 'Simples Nacional', members: ['pgdas_d', 'defis', 'dasn_simei', 'destda'] },
    { code: 'trabalhistas', label: 'Trabalhistas e previdenciárias', members: ['esocial_events'] },
    { code: 'estaduais', label: 'Estaduais', members: ['gia_state', 'dimp', 'dere'] },
    { code: 'comercio_exterior', label: 'Comércio exterior', members: ['due', 'duimp'] },
  ],
};

export const OPERATION_SEED: DimensionSeed = {
  groups: [
    { code: 'comercial', label: 'Compra e venda', members: ['sale', 'resale', 'purchase', 'installment_sale', 'future_delivery_sale', 'sale_on_order', 'consignment', 'auction_sale', 'bonus', 'gift_promotion', 'free_sample_dispatch', 'exchange', 'barter', 'scrap_sale', 'donation', 'devolution', 'return', 'warranty_replacement', 'product_recall', 'commercial_intermediation', 'marketplace_intermediation'] },
    { code: 'movimentacao', label: 'Movimentação e estoque', members: ['shipment', 'transfer', 'delivery', 'pickup', 'distribution', 'storage_service', 'bonded_storage', 'reverse_logistics', 'inventory_write_off', 'stock_loss', 'destruction'] },
    { code: 'comercio_exterior', label: 'Comércio exterior', members: ['importation', 'exportation', 'reexportation', 'reimportation', 'temporary_importation', 'temporary_exportation', 'customs_clearance', 'customs_brokerage', 'customs_transit'] },
    { code: 'industria', label: 'Industrialização', members: ['manufacture', 'contract_manufacture', 'assembly', 'beneficiation', 'blending', 'packaging', 'repackaging', 'refining', 'steelmaking', 'pulp_production', 'ore_concentration', 'pharmaceutical_compounding', 'recycling', 'seed_treatment'] },
    { code: 'agro', label: 'Produção rural e extração', members: ['agricultural_cultivation', 'harvest', 'livestock_raising', 'slaughter', 'grain_cleaning', 'grain_drying', 'extraction'] },
    { code: 'transporte', label: 'Transporte e logística', members: ['cargo_transport', 'transport_service', 'passenger_transport', 'multimodal_transport', 'freight_subcontracting', 'cargo_consolidation', 'cargo_transshipment', 'port_cargo_handling', 'value_transport'] },
    { code: 'servicos', label: 'Serviços', members: ['service_provision', 'professional_consulting', 'engineering_service', 'construction_service', 'installation', 'maintenance', 'repair', 'cleaning_service', 'security_service', 'advertising_service', 'printing_service', 'event_service', 'catering_service', 'restaurant_service', 'hospitality_service', 'travel_agency_service', 'education_service', 'healthcare_service', 'hospital_care', 'medical_diagnostics', 'telecommunication_service'] },
    { code: 'tecnologia', label: 'Tecnologia e direitos', members: ['software_development', 'software_licensing', 'saas_provision', 'cloud_hosting', 'data_processing', 'intellectual_property_license', 'royalty_payment', 'rights_assignment'] },
    { code: 'energia_saneamento', label: 'Energia, água e resíduos', members: ['energy_generation', 'energy_transmission', 'energy_distribution', 'energy_supply', 'energy_trading', 'water_supply', 'sewage_service', 'waste_collection', 'waste_treatment', 'final_disposal'] },
    { code: 'financeiras', label: 'Financeiras', members: ['financial_transaction', 'financial_intermediation', 'loan_granting', 'loan_of_fungibles', 'loan_repayment', 'interest_payment', 'currency_exchange', 'factoring', 'receivables_anticipation', 'receivables_assignment', 'funds_transfer', 'payment_processing', 'guarantee_granting', 'securities_issue', 'securities_trade', 'investment_redemption', 'virtual_asset_custody', 'virtual_asset_exchange', 'consortium_administration', 'financial_lease'] },
    { code: 'seguros_previdencia', label: 'Seguros e previdência', members: ['insurance_contracting', 'insurance_premium_payment', 'insurance_indemnity', 'reinsurance_contracting', 'pension_contribution', 'pension_benefit_payment'] },
    { code: 'imobiliarias', label: 'Imobiliárias', members: ['real_estate_sale', 'real_estate_lease', 'real_estate_development', 'real_estate_brokerage', 'property_management'] },
    { code: 'societarias', label: 'Societárias e patrimoniais', members: ['capital_contribution', 'corporate_absorption', 'corporate_fusion', 'corporate_spin_off', 'profit_distribution', 'asset_disposal', 'inheritance_transfer'] },
    { code: 'locacao', label: 'Locação e cessão de uso', members: ['asset_lease', 'loan_for_use'] },
  ],
};

export const DIMENSION_SEEDS: Record<string, DimensionSeed> = {
  product: PRODUCT_SEED,
  theme: THEME_SEED,
  treatment: TREATMENT_SEED,
  tax: TAX_SEED,
  regime: REGIME_SEED,
  document: DOCUMENT_SEED,
  obligation: OBLIGATION_SEED,
  operation: OPERATION_SEED,
};

export const OFFICIAL_CODE_SEEDS: Record<string, SeedCodes> = {
  product: PRODUCT_NCM_SEED,
  sector: SECTOR_CNAE_SEED,
};
