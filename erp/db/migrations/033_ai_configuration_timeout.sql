-- AI 配置请求超时上限从 30 秒放宽到 180 秒：GRS AI 的文字模型（含思考过程）与图片生成常超过 30 秒，
-- 30 秒上限会把已经成功的任务误判为超时失败。
ALTER TABLE ai_configurations DROP CONSTRAINT ai_configurations_timeout_ms_check;
ALTER TABLE ai_configurations ADD CONSTRAINT ai_configurations_timeout_ms_check CHECK (timeout_ms BETWEEN 1000 AND 180000);

-- 现有 GRS AI 配置统一升到 120 秒，避免用户需要手填超时。
UPDATE ai_configurations SET timeout_ms = 120000, updated_at = now() WHERE template IN ('grsai-product','grsai-image') AND timeout_ms < 120000;
