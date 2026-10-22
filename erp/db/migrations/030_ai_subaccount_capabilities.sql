ALTER TABLE ai_subaccount_permissions
  ADD COLUMN allowed_capabilities text[] NOT NULL DEFAULT ARRAY[
    'product-translation','title-optimization','description-optimization',
    'selling-point-generation','attribute-text-optimization',
    'image-translation','image-redraw','image-repair'
  ]::text[];

