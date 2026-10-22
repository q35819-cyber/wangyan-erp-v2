# 网研 ERP 社区版：AI 接手必读

目标：用户换电脑、换一个AI，也能从本仓库复现安装、账号初始化、启动和手动采集。不要把代码“能编译”称为“可以部署使用”。

## 第一优先级：阅读顺序

1. README.md：当前版本、许可证、公开范围。
2. docs/CONFIGURATION.md：**Windows 全新部署的唯一权威步骤和命令**。
3. docs/DEPLOYMENT_STATUS.md：已验证和未验证的边界。
4. docs/FEATURE_PARITY.md：自有插件0.4.44与原活动插件差异。
5. docs/EXTENSION_INSTALL.md 和 extensions/wyerp-collector/README.md：浏览器采集。
6. docs/USER_GUIDE.md：ERP页面功能。
7. docs/PLUGIN_PROVENANCE.md 和 THIRD_PARTY_NOTICES.md：第三方授权边界。

## 必须遵守的安全限制

- PostgreSQL 是唯一业务数据库；不允许将真实业务数据放入Git或测试文件。
- 严禁连接、覆盖、迁移、重建用户原有的业务数据库或运行时密钥。必须单独创建本机 wyerp_community_* 空库。
- setup-local.ps1 不覆盖任何已有目录；bootstrap-admin.js 不允许修改现有用户/租户。
- 不得将合同、客户、店铺ID、订单、公司信息、手机号、邮箱、客服微信、Cookie、Token、SMTP凭据等写入仓库。
- 不允许恢复废止的无人值守自动订单同步、插件心跳/定时同步、浏览器无权限读取或擅自解锁Ozon Premium。
- 不要把其他第三方软件的闭源JS/CSS只改名就作为本项目源码发布。
- 无人值守自动派发和大批量真店铺测试不属于此部署任务。不可接触原作者真实店铺。

## 安装/测试顺序

克隆仓库 → Node.js/npm ci → 新建隔离 PostgreSQL 角色和数据库 →
erp/scripts/setup-local.ps1 → 数据库迁移 → erp/scripts/bootstrap-admin.ps1（默认自动生成随机管理员密码到外部私有文件）→
erp/scripts/doctor-local.ps1 -CheckDatabase → erp/start.ps1 →
实际浏览器admin登录 → 扩展安装 → 1688商品采集并写入数据库 → Ozon合法页面采集。

具体参数仅以 docs/CONFIGURATION.md 为准，不要自编路径、默认密码或注入开发者历史密钥。

## 完成交付标准

- 明确对每一项标注 PASS / FAIL / 未验证，附可重复的执行步骤；不允许把没有执行的步骤标成PASS。
- 出现 FAIL 必须定位原因并修复后再复测；不要仅提交说明文档。
- 核验插件与后端采集箱的真实持久化，而不是只看扩展图标或采集成功弹窗。
- 公开前跑隐私审查与本机密钥/数据排除检查，并验证GitHub最新main源码。
- 若没有独立 PostgreSQL 或平台账号，必须明确此限制，不能称为完整部署验收。
首次管理员自动创建、密码保管和异常处理统一见 docs/ADMIN_SETUP.md。默认使用安全随机密码，禁止在聊天或日志输出。
