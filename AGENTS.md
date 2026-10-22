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

配置入口与风险强制检查：先阅读 docs/API_CONFIGURATION.md。店铺Seller/Performance API及GRS AI密钥由ERP用户界面配置，SMTP、PG和服务级Key在本机外部私密配置中管理。不得在升级/重装时重新生成旧实例加密密钥。

## 插件安装和版本发布规则

- 浏览器插件版本唯一来源 extensions/wyerp-collector/manifest.json，不能手工把源码、压缩包和文档写成不一致的版本。
- 每次插件发布使用 tools/Build-CollectorPackage.ps1，生成 WyerpCollector-vX.Y.Z.zip 与 sha256，ZIP根目录必须有 Install-Collector.cmd 和 tools/Install-Collector.ps1。
- 用户可双击 Install-Collector.cmd，打开Edge扩展管理页并复制正确目录；普通电脑的本地扩展仍需用户自己启用开发人员模式、选择加载解压缩的扩展并确认。绝不通过企业策略或注册表偷偷强装。
- 后续EXE安装器应自动把插件放到长期固定目录，通过安装页面「安装浏览器插件」按钮调用 tools/Install-Collector.ps1 -PluginDir 该目录；不可把ZIP文件名的版本加入安装后的插件路径。
- 不得把插件版本打包检查PASS，写成浏览器中实际安装PASS或1688/Ozon真实采集PASS。见 docs/EXTENSION_INSTALL.md 和 docs/INSTALLER_PLUGIN_INTEGRATION.md。
2026-10-22实测发现：迁移003和后续SQL要求wyerp_app与wyerp_migrator固定角色。独立PG集群须先创建NOLOGIN兼容角色并授权给当前运行和迁移账号。setup-local.ps1的PUBLIC_ORIGIN必须在本机模式留空，避免图片公网发布模块拒绝HTTP本机地址，公网HTTPS生产部署需要独立验收。

Windows EXE单机版预览：安装层源码及隔离验收详情请阅读installer/README.md。已验证EXE解包、新PostgreSQL17的67项迁移、随机admin、手动Windows服务启动/重启/停止及数据保护；图形安装真实点击、浏览器采集和正式卸载仍未完成。不可宣称正式安装包已通过全部验收。

2026-10-22新增 Windows EXE 预览7：GUI安装/管理器真实按钮启动、重启、关闭/GUI卸载并保留数据库的独立QA已PASS。正式新机安装、采集插件入库、旧数据重装恢复、退出进行中业务任务的一致性仍待测试。安装、构建及换AI操作详见 installer/README.md。
