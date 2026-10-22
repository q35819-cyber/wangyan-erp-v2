-- 头像上传（2026-09-21 用户直令“点击头像需要可以上传头像”）。
-- 归属与 042 一致：头像是“人”的属性，放在按 user_id 全局唯一的 user_profiles，不放 tenant_members，
-- 否则系统管理员换头像会改掉他在别人空间里的显示信息。
-- 只登记私有对象引用，图片字节留在加密私有对象目录（private-objects/<user_id>/user_avatar/...），
-- 数据库不保存 Base64，也不保存任何可公开访问的路径。
-- 附加列全部带默认值且允许旧行为（avatar_object_key='' 即“未上传，继续显示首字符”），不改动 042 已有列。
ALTER TABLE user_profiles
  ADD COLUMN avatar_object_key varchar(400) NOT NULL DEFAULT '',
  ADD COLUMN avatar_content_type varchar(40) NOT NULL DEFAULT '',
  ADD COLUMN avatar_sha256 char(64) NOT NULL DEFAULT '',
  ADD COLUMN avatar_updated_at timestamptz;

-- 引用、摘要、类型和时间必须同时存在或同时为空，避免出现“有引用但无法校验完整性”的半行。
ALTER TABLE user_profiles
  ADD CONSTRAINT user_profiles_avatar_shape_chk CHECK (
    avatar_object_key = '' OR (avatar_content_type <> '' AND avatar_sha256 <> '' AND avatar_updated_at IS NOT NULL)
  );
