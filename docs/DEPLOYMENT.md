# ERP 部署指南入口

所有全新 Windows 环境的部署步骤、PowerShell 可执行命令、PostgreSQL 创建角色及数据库、密钥管理和第一次 admin 初始化，统一见 docs/CONFIGURATION.md。请不要使用本项目以前的旧简略部署说明。

顺序：安装Node.js24与PostgreSQL → npm ci → 新建隔离数据库及账号 →
erp/scripts/setup-local.ps1 → db/migrate.js → erp/scripts/bootstrap-admin.ps1 →
erp/scripts/doctor-local.ps1 -CheckDatabase → erp/start.ps1 → 登录 → 浏览器插件安装及采集箱持久化验证。

禁止直接连接原作者已有业务库，禁止从本机私密目录导入旧数据库和店铺密钥，禁止恢复无人值守订单自动同步。

开发、测试和实际发布目前默认只允许127.0.0.1:8765；公网生产部署尚未完成安全验收。
当前通过npm ci与离线采集插件测试，但全新PostgreSQL+真实1688/Ozon网页端到端尚未完成独立测试，详见 docs/DEPLOYMENT_STATUS.md。