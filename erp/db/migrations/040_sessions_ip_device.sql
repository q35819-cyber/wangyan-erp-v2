-- mem01 #45 整改（2026-09-19 用户授权 Schema 变更，调度退回项）：
-- 设备管理表的 IP地址/设备号此前硬编码“待服务端支持”占位，属占位冒充交付。
-- 本迁移为 sessions 增服务端权威字段：ip_address=登录请求的服务端采集地址（clientAddress），
-- device_id=当次登录签发/沿用的 64 位十六进制设备标识（ensureRequestDeviceId，经 HttpOnly Cookie 持久化）。
-- 两列均可空：历史会话在字段上线前登录，无真实值可考，保持 NULL 由界面显示“登录时未记录”，禁止回填伪造。
-- 前端自报值不得入库：写入只发生在 createSession 的服务端上下文参数，且设备号格式在存储层再校验。
ALTER TABLE sessions
  ADD COLUMN ip_address varchar(64) CHECK (ip_address IS NULL OR ip_address ~ '^[0-9a-fA-F.:]{1,64}$'),
  ADD COLUMN device_id varchar(64) CHECK (device_id IS NULL OR device_id ~ '^[a-f0-9]{64}$');
