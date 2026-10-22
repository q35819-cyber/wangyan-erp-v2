# 网研 ERP API 配置与换机风险审核

这份文档根据公开统一Release实际页面、环境变量和后端代码编写，不包含开发者的任何真实密钥。新AI先阅读 AGENTS.md 与 docs/CONFIGURATION.md。

## API配置入口

| 业务 | 配置入口 | 填写内容 | 当前限制 |
| --- | --- | --- | --- |
| Ozon Seller API | ERP 左侧 店铺列表 → 新增店铺/编辑 | 店铺名称、Client ID、Seller API Key | 店铺凭据由服务器以租户隔离方式加密储存；页面只显示已配置，不回显密钥 |
| Ozon Performance API（广告费/CPO） | 同一店铺编辑弹窗的广告费接口 | Performance Client ID、Client Secret | 与Seller API独立，须成对配置；不能共用Seller密钥 |
| AI文本/图片API | ERP左侧 AI配置 → AI服务配置 → 新增 | 自己的 GRS AI Key、能力、文本/图片模型 | 当前界面仅开放 GRS AI；文本与生图模型有固定清单；视频仅登记，不承诺真实生成 |
| 1688商品采集 | Edge/Chrome加载 extensions/wyerp-collector，打开商品页 | 当前浏览器合法页面访问与ERP登录态 | 1688账号授权菜单明确标记「尚未实现」，不存在成熟的官方1688 API填写页 |
| QQ SMTP邮箱（验证码/反馈） | 新机运行 erp/configure-smtp.ps1 -DataRoot 指定的新数据目录 | 自己的QQ邮箱和SMTP授权码 | 存入外部 secrets/wyerp.env；不在ERP网页填写；当前脚本只支持QQ |
| Seerfar 外部API | 外部密钥文件 + ERP_SEERFAR_API_KEY_FILE 环境变量 | 自己合法取得的服务密钥 | 不是常规用户图形界面选项；不能内置第三方个人账号 |
| 平台官方AI服务级密钥 | 外部文件 + ERP_OFFICIAL_AI_API_KEY_FILE 环境变量 | 自己服务的API Key | 部分服务级调用依赖此配置，非所有AI用户功能 |
| PostgreSQL | DataRoot/secrets/wyerp.env | 本机新建PG数据库、运行账号和迁移账号 | 不是店铺API，严格只使用隔离新库 |
| 1688类目树 / Ozon佣金表 | ERP_1688_CATEGORY_TREE_FILE / ERP_OZON_GLOBAL_COMMISSION_FILE | 合法取得的数据文件路径 | 数据文件未随开源仓库提供，需要自行准备、校验 |
| 接口列表 | ERP左侧 接口列表（管理员） | 主要查看接口状态 | 不是店铺 API Key 录入页 |

## 实际验收顺序

1. 安装完成并登录ERP后，在正确租户的店铺列表中添加自己合法拥有的测试店铺，保存并点击测试连接。
2. 需要广告费时再单独填写Performance双凭据，否则不能保证CPO/广告费完整。
3. 租户所有者在AI配置中填写自己的GRS AI API Key，选择相应模型，测试连接；功能测试可能收费。
4. 安装采集插件后在1688/Ozon商品页手动采集，返回ERP采集箱核实数据库写入。
5. SMTP可以先留空以便验收基础功能，但邮件验证码、找回密码和BUG发送可能受限。需要启用时使用configure-smtp.ps1；必须用新邮箱和新授权码。
6. 不能把「已填写密钥」等同于「API已经调用成功」。

## 配置风险和处理状态

P0 已修复：旧版 configure-smtp.ps1 以前会把整个 wyerp.env 重写为邮件字段，删除已有PostgreSQL和其他配置。新版只编辑SMTP字段，保留原环境变量、原ACL；使用隔离测试文件验证DB字段和未知字段保持不变、重复键拒绝、临时文件清理。真实QQ发件尚未验证。

P0 必须保护：credentials.key 是加密Ozon店铺及AI API凭据的密钥；private-object.key加密部分私有资料；csrf.key用于请求校验。升级、重装不得重新生成或删除旧密钥；单独恢复数据库而丢失密钥可能导致保存过的店铺/API凭据无法解密。务必将数据库和对应密钥安全备份并做恢复演练。

P1 未解决：全新脚本默认 NODE_ENV=development 和本机8765端口；若改为 production 或 EXE/云服务器，生产代码还检查 ERP_CSRF_SECRET、PUBLIC_ORIGIN 等，与启动脚本采用 ERP_CSRF_SECRET_FILE 的方式并非完全一致。不能简单打开公网地址，必须做专项安全/启动测试。

P1 平台限制：Ozon Seller API与Performance API不是一套凭据；1688授权功能尚未实现；GRS AI文本/图片模型和请求域名写入代码，第三方服务更新可能导致模型失效。未有合法的第三方权限和数据时不能模拟为已配置。

P1 安装器风险：不能自动删除或重建已有PG数据库、不能覆盖原用户的数据目录和密钥；卸载默认保留数据，升级先备份。真实新机PG迁移、admin网页登录和1688/Ozon页面实际写库仍未端到端通过。

P2 日志与费用：禁止打印Cookie、Authorization、SMTP授权码、API Key、数据库凭据和用户经营数据。AI功能测试可能计费，连接成功也不代表平台账号有访问所有功能的权限。

## 给下一位AI/安装器开发者的要求

- 店铺和AI API优先在ERP页面填写，不要把它们混入安装器的.env文件或日志。
- 系统级的SMTP、PG、Seerfar与官方AI密钥存放在Git仓库外部受限的secrets目录。
- 新安装生成新密钥，老版本升级必须保留原密钥与数据库。
- 按 docs/CONFIGURATION.md 和 docs/DEPLOYMENT_STATUS.md 完成真实新机验收，不得把静态测试误写为全面可用。
本机安装防启动故障：PUBLIC_ORIGIN必须留空，避免图片发布模块将HTTP本机地址当作公网HTTPS地址而拒绝整个ERP启动。ERP_HOST=127.0.0.1和ERP_PORT仍负责本机监听；生产HTTPS公网域名须按独立生产部署流程验收。
