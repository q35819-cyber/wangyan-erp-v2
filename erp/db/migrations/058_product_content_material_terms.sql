-- 058：只补057存量全局策略材料词表，已有数组不覆盖；不改正文及其它策略。
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ai_product_content_rules WHERE rule_key='global' AND jsonb_typeof(policy)='object' AND policy->>'schemaVersion'='1') THEN
    RAISE EXCEPTION '全局策略结构异常，材料许可表迁移已中止';
  END IF;
  IF EXISTS (SELECT 1 FROM ai_product_content_rules WHERE rule_key='global' AND policy ? 'materialTerms' AND jsonb_typeof(policy->'materialTerms') <> 'array') THEN
    RAISE EXCEPTION '现有材料许可表格式异常，迁移已中止且未覆盖';
  END IF;
END $guard$;
UPDATE ai_product_content_rules
SET policy=jsonb_set(policy,'{materialTerms}','["PVC", "ABS", "PP", "PE", "HDPE", "LDPE", "PET", "PBT", "PC", "PS", "PA", "POM", "PMMA", "PTFE", "TPE", "TPU", "PU", "NBR", "EPDM", "SBR", "silicone", "silicone rubber", "polyurethane", "polyethylene", "polypropylene", "polyvinyl chloride", "polycarbonate", "polyamide", "polyester", "nylon", "cotton", "wool", "silk", "linen", "viscose", "rayon", "acrylic", "spandex", "stainless steel", "carbon steel", "aluminium", "aluminum", "aluminium alloy", "aluminum alloy", "copper", "brass", "bronze", "titanium", "glass", "ceramic", "rubber", "natural rubber", "glass fiber", "fiberglass"]'::jsonb),updated_at=now()
WHERE rule_key='global' AND NOT (policy ? 'materialTerms');