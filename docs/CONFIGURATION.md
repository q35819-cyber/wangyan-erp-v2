# 网研 ERP 全新 Windows 换机部署（AI 接手必读）

这是在完全新电脑上使用全新 PostgreSQL 数据库的社区部署流程。不能直接连接原作者业务数据库。除第一步需要安装软件，后续每一步均有可执行命令、检查方法和失败条件。

前提：Windows 10/11、PowerShell 5.1+、Node.js 24（实际支持 --env-file-if-exists 的 Node.js 22.9+）、PostgreSQL 16+、Edge 或 Chrome。需要联网安装 npm 依赖，但运行 ERP 时必须限制在本机 127.0.0.1:8765。必须先验证功能再考虑远程/公网部署；此版本没有完成生产安全验收。

## 第一步：下载代码和依赖

从 https://github.com/q35819-cyber/wangyan-erp-v2 克隆到新的空工作目录：

    git clone https://github.com/q35819-cyber/wangyan-erp-v2.git
    cd wangyan-erp-v2\erp
    node --version
    npm ci
    npm run check:syntax

npm ci 安装后不要把 node_modules 上传到 Git。插件并不需要 npm 打包，位于仓库根目录 extensions/wyerp-collector。

## 第二步：在本机 PostgreSQL 创建全新用户和数据库

确认本机已经运行 PostgreSQL，并且你有自己设置的 postgres 管理员账号。使用 PostgreSQL 安装包附带的 psql（不在 PATH 时使用其 bin 目录完整路径）进入本地 postgres 数据库：

    psql -h 127.0.0.1 -U postgres -d postgres

在 psql 交互命令行执行下面命令，每条以分号结尾。数据库和角色均为新名字，绝不可改为以前使用过的正式库：

    CREATE ROLE wyerp_community_migrator LOGIN;
    CREATE ROLE wyerp_community_app LOGIN;
    \password wyerp_community_migrator
    \password wyerp_community_app
    CREATE DATABASE wyerp_community_fresh OWNER wyerp_community_migrator;
    GRANT CONNECT ON DATABASE wyerp_community_fresh TO wyerp_community_app;
    \connect wyerp_community_fresh
    GRANT USAGE ON SCHEMA public TO wyerp_community_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE wyerp_community_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO wyerp_community_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE wyerp_community_migrator IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO wyerp_community_app;

\password 是 psql 交互指令：会让你输入各自密码，而不是把明文密码写进 SQL、终端历史或 Git。

如果提示角色或数据库已存在，立即停止这一步，换一个全新的数据库命名，不能删除/覆盖现有数据库以图省事。本项目提供的初始化程序默认名称是 wyerp_community_fresh；若改名，下一步必须使用同样名称。

## 第三步：初始化本机保密配置与随机密钥

回到刚克隆的仓库 erp 目录：

    $root = Join-Path $env:LOCALAPPDATA 'WyerpCommunityFresh'
    .\scripts\setup-local.ps1 -DataRoot $root

按照提示，输入上一步新建的运行账号和迁移账号密码。这个工具只允许全新空目录，写入本机独立的 secrets/wyerp.env，以及三个不同的随机密钥文件；不覆盖已有文件，也不访问原来的服务器。

如果电脑上曾安装过 ERP，请选择另外一个新目录，不能使用原项目的 本机数据、WyerpData 或正在使用的数据库。

设置当前终端的数据目录，以下命令仅影响这个 PowerShell 窗口：

    $env:WYERP_LOCAL_DATA_ROOT = $root

运行静态环境自检：

    .\scripts\doctor-local.ps1 -DataRoot $root

如果报告缺少 npm 依赖、密钥或插件文件，请按 FAIL 提示先修复，不要强行启动。

## 第四步：初始化全新数据库 Schema

从仓库 erp 目录，使用外部配置的 PostgreSQL 账号执行：

    $envFile = Join-Path $root 'secrets/wyerp.env'
    node "--env-file-if-exists=$envFile" db/migrate.js
    node "--env-file-if-exists=$envFile" db/migrate.js --check

必须看到迁移无 pending，不能忽略迁移失败。初始化前必须确认连接的数据库名称是 wyerp_community_fresh，并且里面没有任何真实用户或店铺资料。

## 第五步：设置唯一 admin 并启动

首次管理员不存在于源码（出于安全，禁止预置通用密码）。这一步只在全新空数据库、且迁移全部完成后执行一次：

    .\scripts\bootstrap-admin.ps1 -DataRoot $root

默认自动生成43字符随机管理员密码，保存在新机外部 secrets/initial-admin-password.txt，用户名为admin。详情及查看/清理方法见 docs/ADMIN_SETUP.md。若要手工输入密码请加 -PromptForPassword。仅空库执行一次；第二次执行会拒绝。

完整检查：

    .\scripts\doctor-local.ps1 -DataRoot $root -CheckDatabase

通过后启动 ERP：

    .\start.ps1

打开浏览器访问 http://127.0.0.1:8765 ，用 admin 及新密码登录。页面能打开和账号成功登录都需要实际验收。SMTP 默认不配置；如果需要使用邮件验证码、自助注册或BUG邮件通知，请另外申请自己的邮箱服务并在外部 secrets/wyerp.env 中配置自己的 SMTP_USER、SMTP_PASS、SMTP_FROM、BUG_REPORT_EMAIL，严禁上传 Git。

## 第六步：安装采集插件并验证商品

按照 docs/EXTENSION_INSTALL.md 在 Edge/Chrome 加载 extensions/wyerp-collector（不是目录上一层），到 1688 商品页手动采集一件测试商品，返回 ERP 的采集箱确认标题、SKU、图片和来源。再尝试 Ozon 已授权公开商品页。

### 换机必须填写的验收表

1. Git克隆、Node与npm ci：PASS / FAIL
2. 全新PostgreSQL及67份迁移（以实际版本为准）：PASS / FAIL
3. 初始化唯一admin并完成网页登录：PASS / FAIL
4. 浏览器插件加载正常：PASS / FAIL
5. 1688商品页手动采集并真正保存数据库：PASS / FAIL
6. Ozon商品页手动采集并真正保存数据库：PASS / FAIL
7. 店铺API只使用新店铺合法授权：PASS / FAIL / 未配置
8. 已停用的无人值守自动订单同步、插件心跳：未恢复

不可以用纯语法通过替代真实浏览器采集结果。不存在的第三方类目树、佣金表和平台API权限，需要使用者自己准备合法数据并验收。

## 自动检查的安全边界

setup-local.ps1：只生成仓库外部的本机新配置，拒绝覆盖目录。
doctor-local.ps1：只做环境、密钥和可选迁移状态查询，不修改用户业务数据。
bootstrap-admin.ps1：先验证全新空库及迁移校验，再创建一个admin；只执行一次。
start.ps1：原Release启动脚本，在正式服务启动前先检查迁移状态。

脚本不会下载或恢复原作者的私人数据。当前尚未在一台有独立PostgreSQL安装和真实浏览器测试账号的全新电脑完成第2—6步端到端演练，参见 docs/DEPLOYMENT_STATUS.md。

API配置位置与部署风险：参见 docs/API_CONFIGURATION.md。重要：不要使用任何旧版本的configure-smtp.ps1，曾存在覆盖整个环境配置的缺陷；本版已只替换邮件字段并通过合成数据测试。生产启动模式及首次数据库全量验收尚未通过。
