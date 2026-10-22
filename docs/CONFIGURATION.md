# 网研ERP跨电脑配置说明（AI接手版）

源代码入口：erp/server.js、erp/cluster.js、erp/start.ps1、erp/db/config.js、erp/db/migrate.js。

重要环境变量：
- ERP_HOST、ERP_PORT：本机默认127.0.0.1、8765；插件仅接受8765端口。
- PGHOST、PGPORT、PGDATABASE、PGUSER、PGPASSWORD：新的独立PostgreSQL实例。
- PGMIGRATIONUSER、PGMIGRATIONPASSWORD：只用于结构迁移的独立身份。
- ERP_DATA_DIR：持久数据目录，正式环境应在代码库之外。
- ERP_PRIVATE_OBJECT_DIR、ERP_PRIVATE_OBJECT_KEY：隐私图片/对象目录及新密钥。
- ERP_CSRF_SECRET、ERP_CREDENTIALS_KEY：新环境随机密钥，不能复用原开发者秘钥。
- PUBLIC_ORIGIN：服务外部地址，正式部署必须有HTTPS；旧Release暂停公网启用。
- SMTP_USER、SMTP_PASS、SMTP_FROM、BUG_REPORT_EMAIL：邮件账号、授权码、收件邮箱，默认空。
- ERP_1688_CATEGORY_TREE_FILE：1688类目文件，需自行取得合法资料。
- ERP_OZON_GLOBAL_COMMISSION_FILE：Ozon佣金参考表，未随源码发布。

建议使用兼容的Node.js 24版本及PostgreSQL。Windows新电脑先克隆代码，进入erp目录运行 npm ci。
在新的空数据库上执行 node db/migrate.js，再运行 node db/migrate.js --check。
启动脚本会从新电脑的本机数据配置目录或 WYERP_LOCAL_DATA_ROOT/secrets/wyerp.env 读取环境变量；这些文件不会由GitHub提供，需安全地手动创建。
之后执行 erp/start.ps1，登录本机8765端口，核验首次管理员初始化、租户权限等。
最后依照 docs/EXTENSION_INSTALL.md 安装插件。

当前开源包尚未在新电脑完成端到端部署测试，特别是首次管理员创建和数据库权限配置；另一个AI应实际执行、排查、修正并将可复现的步骤更新到文档。不要使用原作者数据库和账号，也不得恢复无人值守订单自动同步。