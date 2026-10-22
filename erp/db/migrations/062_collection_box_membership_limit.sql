-- 采集箱会员额度：按商品条目数统计，不按 SKU 数统计。
-- 只更新当前 published 方案，或仍被有效会员周期引用的历史方案；不改无人使用的 retired 历史版本。
WITH limits(plan_code, collection_box_limit) AS (
  VALUES
    ('trial'::varchar, 100),
    ('month'::varchar, 500),
    ('quarter'::varchar, 1500),
    ('year'::varchar, 5000)
)
UPDATE membership_plan_versions v
SET benefits = jsonb_set(v.benefits, '{collectionBoxLimit}', to_jsonb(l.collection_box_limit), true)
FROM limits l
WHERE v.plan_code = l.plan_code
  AND (
    v.status = 'published'
    OR EXISTS (
      SELECT 1
      FROM membership_periods p
      WHERE p.plan_version_id = v.id
        AND p.state = 'active'
        AND p.starts_at <= now()
        AND (p.ends_at IS NULL OR p.ends_at > now())
    )
  )
  AND COALESCE((v.benefits->>'collectionBoxLimit')::integer, -1) <> l.collection_box_limit;
