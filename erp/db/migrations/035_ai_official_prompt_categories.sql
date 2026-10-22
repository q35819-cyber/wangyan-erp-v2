-- 官方图片提示词类别改为用户确认的六类（主图、场景图、卖点图、配件赠品图、白底图、尺寸图）。
ALTER TABLE ai_official_prompts DROP CONSTRAINT IF EXISTS ai_official_prompts_function_key_check;

-- 先把 034 种子里的 image-redraw 归位到语义对应的新类别，再收紧约束。
UPDATE ai_official_prompts SET function_key = CASE WHEN official_key = 'image-clean-white-base' THEN 'image-white-base' ELSE 'image-scene' END WHERE function_key = 'image-redraw';

ALTER TABLE ai_official_prompts ADD CONSTRAINT ai_official_prompts_function_key_check CHECK (function_key IN ('image-main','image-scene','image-selling','image-accessory','image-white-base','image-size'));